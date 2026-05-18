import { describe, it, expect, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { GroupItemType } from "@/generated/prisma/enums";
import { createGroup, getGroup, listGroups } from "./group-domain";
import { ConflictError, NotFoundError } from "@/utils/mcp-server/errors";

vi.mock("@/utils/prisma");
vi.mock("@/utils/prisma-helpers", () => ({
  isDuplicateError: vi.fn(),
}));
import { isDuplicateError } from "@/utils/prisma-helpers";

const ctx = { userId: "user_1", emailAccountId: "ea_1" };

describe("listGroups", () => {
  it("returns empty array when no groups exist", async () => {
    prisma.group.findMany.mockResolvedValue([] as never);

    const result = await listGroups(ctx);

    expect(result.groups).toEqual([]);
    expect(prisma.group.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { emailAccountId: ctx.emailAccountId },
      }),
    );
  });

  it("scopes findMany to caller emailAccountId", async () => {
    prisma.group.findMany.mockResolvedValue([] as never);

    await listGroups(ctx);

    expect(prisma.group.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { emailAccountId: ctx.emailAccountId },
      }),
    );
  });

  it("returns mapped groups with item count and rule link", async () => {
    const now = new Date();
    prisma.group.findMany.mockResolvedValue([
      {
        id: "g1",
        name: "Newsletters",
        prompt: null,
        createdAt: now,
        updatedAt: now,
        rule: { id: "r1", name: "Newsletter Rule" },
        _count: { items: 3 },
      },
    ] as never);

    const result = await listGroups(ctx);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      id: "g1",
      name: "Newsletters",
      itemCount: 3,
      rule: { id: "r1", name: "Newsletter Rule" },
    });
    expect(result.groups[0].createdAt).toBe(now.toISOString());
  });
});

describe("getGroup", () => {
  it("returns the group with its items", async () => {
    const now = new Date();
    prisma.group.findUnique.mockResolvedValue({
      id: "g1",
      name: "g1",
      prompt: null,
      emailAccountId: ctx.emailAccountId,
      createdAt: now,
      updatedAt: now,
      rule: { id: "r1", name: "Rule 1" },
      items: [
        {
          id: "item1",
          type: GroupItemType.FROM,
          value: "x@y.z",
          exclude: false,
          source: null,
          createdAt: now,
        },
      ],
    } as never);

    const result = await getGroup(ctx, { groupId: "g1" });

    expect(result.group.id).toBe("g1");
    expect(result.group.items).toHaveLength(1);
    expect(result.group.items[0]).toMatchObject({
      type: GroupItemType.FROM,
      value: "x@y.z",
      exclude: false,
    });
  });

  it("throws NotFoundError when group does not exist", async () => {
    prisma.group.findUnique.mockResolvedValue(null as never);

    await expect(getGroup(ctx, { groupId: "nope" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("throws NotFoundError when group belongs to another account", async () => {
    prisma.group.findUnique.mockResolvedValue({
      id: "g1",
      name: "g1",
      prompt: null,
      emailAccountId: "other_account",
      createdAt: new Date(),
      updatedAt: new Date(),
      rule: null,
      items: [],
    } as never);

    await expect(getGroup(ctx, { groupId: "g1" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("createGroup", () => {
  it("creates a group bound to the rule and returns groupId", async () => {
    prisma.rule.findUnique.mockResolvedValue({
      id: "r1",
      name: "Newsletters",
      groupId: null,
      emailAccountId: ctx.emailAccountId,
    } as never);
    prisma.group.create.mockResolvedValue({
      id: "g_new",
      name: "Newsletters",
    } as never);
    vi.mocked(isDuplicateError).mockReturnValue(false);

    const result = await createGroup(ctx, { ruleId: "r1" });
    expect(result.groupId).toBe("g_new");
    expect(prisma.group.create).toHaveBeenCalled();
  });

  it("returns existing groupId if rule already has a group", async () => {
    prisma.rule.findUnique.mockResolvedValue({
      id: "r1",
      name: "Newsletters",
      groupId: "g_existing",
      emailAccountId: ctx.emailAccountId,
    } as never);

    const result = await createGroup(ctx, { ruleId: "r1" });
    expect(result.groupId).toBe("g_existing");
    expect(prisma.group.create).not.toHaveBeenCalled();
  });

  it("throws NotFoundError when rule does not belong to caller", async () => {
    prisma.rule.findUnique.mockResolvedValue({
      id: "r1",
      name: "X",
      groupId: null,
      emailAccountId: "other_account",
    } as never);

    await expect(createGroup(ctx, { ruleId: "r1" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("throws NotFoundError when rule is missing", async () => {
    prisma.rule.findUnique.mockResolvedValue(null as never);

    await expect(
      createGroup(ctx, { ruleId: "missing" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws ConflictError on duplicate name", async () => {
    prisma.rule.findUnique.mockResolvedValue({
      id: "r1",
      name: "Taken",
      groupId: null,
      emailAccountId: ctx.emailAccountId,
    } as never);
    const dupErr = Object.assign(new Error("dup"), {
      code: "P2002",
      meta: { target: ["name"] },
    });
    prisma.group.create.mockRejectedValue(dupErr);
    vi.mocked(isDuplicateError).mockReturnValue(true);

    await expect(createGroup(ctx, { ruleId: "r1" })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});
