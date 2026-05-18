import { describe, it, expect, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { GroupItemType } from "@/generated/prisma/enums";
import {
  addGroupItem,
  createGroup,
  deleteGroup,
  getGroup,
  listGroups,
  previewGroupDeletion,
  removeGroupItem,
  updateGroup,
} from "./group-domain";
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

describe("updateGroup", () => {
  it("updates name and prompt", async () => {
    prisma.group.findUnique.mockResolvedValue({
      id: "g1",
      emailAccountId: ctx.emailAccountId,
    } as never);
    prisma.group.update.mockResolvedValue({
      id: "g1",
      name: "new",
      prompt: "describe me",
      updatedAt: new Date(),
    } as never);
    vi.mocked(isDuplicateError).mockReturnValue(false);

    const result = await updateGroup(ctx, {
      groupId: "g1",
      name: "new",
      prompt: "describe me",
    });
    expect(result.group.name).toBe("new");
    expect(result.group.prompt).toBe("describe me");
  });

  it("throws NotFoundError when group missing", async () => {
    prisma.group.findUnique.mockResolvedValue(null as never);

    await expect(
      updateGroup(ctx, { groupId: "missing", name: "y" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError for other account's group", async () => {
    prisma.group.findUnique.mockResolvedValue({
      id: "g1",
      emailAccountId: "other_account",
    } as never);

    await expect(
      updateGroup(ctx, { groupId: "g1", name: "y" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws ConflictError on duplicate name", async () => {
    prisma.group.findUnique.mockResolvedValue({
      id: "g1",
      emailAccountId: ctx.emailAccountId,
    } as never);
    const dupErr = Object.assign(new Error("dup"), {
      code: "P2002",
      meta: { target: ["name"] },
    });
    prisma.group.update.mockRejectedValue(dupErr);
    vi.mocked(isDuplicateError).mockReturnValue(true);

    await expect(
      updateGroup(ctx, { groupId: "g1", name: "taken" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("previewGroupDeletion", () => {
  it("returns group summary and cascade item count without deleting", async () => {
    prisma.group.findUnique.mockResolvedValue({
      id: "g1",
      name: "g1",
      emailAccountId: ctx.emailAccountId,
      _count: { items: 2 },
    } as never);

    const preview = await previewGroupDeletion(ctx, { groupId: "g1" });
    expect(preview).toEqual({
      action: "delete_group",
      group: { id: "g1", name: "g1" },
      willCascade: { items: 2 },
      irreversible: true,
    });
    // No delete call.
    expect(prisma.group.delete).not.toHaveBeenCalled();
  });

  it("throws NotFoundError for missing group", async () => {
    prisma.group.findUnique.mockResolvedValue(null as never);
    await expect(
      previewGroupDeletion(ctx, { groupId: "missing" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError for foreign group", async () => {
    prisma.group.findUnique.mockResolvedValue({
      id: "g1",
      name: "g1",
      emailAccountId: "other_account",
      _count: { items: 0 },
    } as never);
    await expect(
      previewGroupDeletion(ctx, { groupId: "g1" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("deleteGroup", () => {
  it("deletes the group and reports cascaded item count", async () => {
    prisma.group.findUnique.mockResolvedValue({
      id: "g1",
      emailAccountId: ctx.emailAccountId,
      _count: { items: 3 },
    } as never);
    prisma.group.delete.mockResolvedValue({ id: "g1" } as never);

    const result = await deleteGroup(ctx, { groupId: "g1", confirm: true });
    expect(result).toEqual({ deletedGroupId: "g1", deletedItems: 3 });
    expect(prisma.group.delete).toHaveBeenCalledWith({ where: { id: "g1" } });
  });

  it("throws NotFoundError when group missing", async () => {
    prisma.group.findUnique.mockResolvedValue(null as never);
    await expect(
      deleteGroup(ctx, { groupId: "missing", confirm: true }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError for foreign group", async () => {
    prisma.group.findUnique.mockResolvedValue({
      id: "g1",
      emailAccountId: "other_account",
      _count: { items: 0 },
    } as never);
    await expect(
      deleteGroup(ctx, { groupId: "g1", confirm: true }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("addGroupItem", () => {
  it("creates an item bound to the group", async () => {
    prisma.group.findUnique.mockResolvedValue({
      id: "g1",
      emailAccountId: ctx.emailAccountId,
    } as never);
    prisma.groupItem.create.mockResolvedValue({
      id: "item_new",
      type: GroupItemType.FROM,
      value: "newsletter@x.co",
      exclude: false,
    } as never);
    vi.mocked(isDuplicateError).mockReturnValue(false);

    const result = await addGroupItem(ctx, {
      groupId: "g1",
      type: GroupItemType.FROM,
      value: "newsletter@x.co",
    });
    expect(result.item.id).toBe("item_new");
    expect(result.item.value).toBe("newsletter@x.co");
  });

  it("throws NotFoundError when group missing", async () => {
    prisma.group.findUnique.mockResolvedValue(null as never);
    await expect(
      addGroupItem(ctx, {
        groupId: "missing",
        type: GroupItemType.FROM,
        value: "z@y.co",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError for foreign group", async () => {
    prisma.group.findUnique.mockResolvedValue({
      id: "g1",
      emailAccountId: "other_account",
    } as never);
    await expect(
      addGroupItem(ctx, {
        groupId: "g1",
        type: GroupItemType.FROM,
        value: "z@y.co",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("returns existing item id on duplicate (idempotent)", async () => {
    prisma.group.findUnique.mockResolvedValue({
      id: "g1",
      emailAccountId: ctx.emailAccountId,
    } as never);
    const dupErr = Object.assign(new Error("dup"), {
      code: "P2002",
      meta: { target: ["groupId", "type", "value"] },
    });
    prisma.groupItem.create.mockRejectedValue(dupErr);
    vi.mocked(isDuplicateError).mockReturnValue(true);
    prisma.groupItem.findUnique.mockResolvedValue({
      id: "item_existing",
      type: GroupItemType.FROM,
      value: "dup@x.co",
      exclude: false,
    } as never);

    const result = await addGroupItem(ctx, {
      groupId: "g1",
      type: GroupItemType.FROM,
      value: "dup@x.co",
    });
    expect(result.item.id).toBe("item_existing");
  });
});

describe("removeGroupItem", () => {
  it("deletes the item", async () => {
    prisma.groupItem.findUnique.mockResolvedValue({
      id: "item_1",
      group: { emailAccountId: ctx.emailAccountId },
    } as never);
    prisma.groupItem.delete.mockResolvedValue({ id: "item_1" } as never);

    const result = await removeGroupItem(ctx, { itemId: "item_1" });
    expect(result).toEqual({ deletedItemId: "item_1" });
    expect(prisma.groupItem.delete).toHaveBeenCalledWith({
      where: { id: "item_1" },
    });
  });

  it("throws NotFoundError when item missing", async () => {
    prisma.groupItem.findUnique.mockResolvedValue(null as never);
    await expect(
      removeGroupItem(ctx, { itemId: "missing" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError for foreign item", async () => {
    prisma.groupItem.findUnique.mockResolvedValue({
      id: "item_1",
      group: { emailAccountId: "other_account" },
    } as never);
    await expect(
      removeGroupItem(ctx, { itemId: "item_1" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
