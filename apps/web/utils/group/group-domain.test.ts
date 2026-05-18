import { describe, it, expect, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { GroupItemType } from "@/generated/prisma/enums";
import { getGroup, listGroups } from "./group-domain";
import { NotFoundError } from "@/utils/mcp-server/errors";

vi.mock("@/utils/prisma");
vi.mock("@/utils/prisma-helpers", () => ({
  isDuplicateError: vi.fn(),
}));

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
