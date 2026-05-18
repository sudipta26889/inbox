import { describe, it, expect, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { GroupItemType } from "@/generated/prisma/enums";
import {
  adminGroupsAddItem,
  adminGroupsCreate,
  adminGroupsDelete,
  adminGroupsGet,
  adminGroupsList,
  adminGroupsRemoveItem,
  adminGroupsUpdate,
} from "./admin-groups-tools";
import type { McpToolContext } from "./registry";

vi.mock("@/utils/prisma");
vi.mock("@/utils/prisma-helpers", () => ({
  isDuplicateError: vi.fn(),
}));
import { isDuplicateError } from "@/utils/prisma-helpers";

const ctx: McpToolContext = {
  clientId: "test-client",
  userId: "user_1",
  emailAccountId: "ea_1",
  scopes: ["admin"],
};

describe("adminGroupsList", () => {
  it("returns ok envelope with groups array", async () => {
    prisma.group.findMany.mockResolvedValue([] as never);

    const result = await adminGroupsList(ctx, {});

    expect(result).toEqual({ ok: true, data: { groups: [] } });
  });
});

describe("adminGroupsGet", () => {
  it("returns NOT_FOUND envelope when group missing", async () => {
    prisma.group.findUnique.mockResolvedValue(null as never);

    const result = await adminGroupsGet(ctx, { groupId: "missing" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("returns VALIDATION_ERROR for bad input", async () => {
    const result = await adminGroupsGet(ctx, {});

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns ok envelope with group data on success", async () => {
    const now = new Date();
    prisma.group.findUnique.mockResolvedValue({
      id: "g1",
      name: "g1",
      prompt: null,
      emailAccountId: ctx.emailAccountId,
      createdAt: now,
      updatedAt: now,
      rule: null,
      items: [],
    } as never);

    const result = await adminGroupsGet(ctx, { groupId: "g1" });

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const data = result.data as { group: { id: string } };
      expect(data.group.id).toBe("g1");
    }
  });
});

describe("adminGroupsCreate", () => {
  it("creates a group bound to a rule and returns ok envelope", async () => {
    prisma.rule.findUnique.mockResolvedValue({
      id: "r1",
      name: "Newsletter",
      groupId: null,
      emailAccountId: ctx.emailAccountId,
    } as never);
    prisma.group.create.mockResolvedValue({
      id: "g_new",
      name: "Newsletter",
    } as never);
    vi.mocked(isDuplicateError).mockReturnValue(false);

    const result = await adminGroupsCreate(ctx, { ruleId: "r1" });

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect((result.data as { groupId: string }).groupId).toBe("g_new");
    }
  });

  it("returns VALIDATION_ERROR for missing ruleId", async () => {
    const result = await adminGroupsCreate(ctx, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("adminGroupsUpdate", () => {
  it("updates a group and returns ok envelope", async () => {
    prisma.group.findUnique.mockResolvedValue({
      id: "g1",
      emailAccountId: ctx.emailAccountId,
    } as never);
    prisma.group.update.mockResolvedValue({
      id: "g1",
      name: "Renamed",
      prompt: null,
      updatedAt: new Date(),
    } as never);
    vi.mocked(isDuplicateError).mockReturnValue(false);

    const result = await adminGroupsUpdate(ctx, {
      groupId: "g1",
      name: "Renamed",
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const data = result.data as { group: { name: string } };
      expect(data.group.name).toBe("Renamed");
    }
  });
});

describe("adminGroupsDelete (destructive)", () => {
  it("returns dryRun preview without confirm and does not delete", async () => {
    prisma.group.findUnique.mockResolvedValue({
      id: "g1",
      name: "g1",
      emailAccountId: ctx.emailAccountId,
      _count: { items: 1 },
    } as never);

    const result = await adminGroupsDelete(ctx, { groupId: "g1" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dryRun).toBe(true);
    expect(result.preview).toMatchObject({
      action: "delete_group",
      group: { id: "g1", name: "g1" },
      willCascade: { items: 1 },
      irreversible: true,
    });
    expect(prisma.group.delete).not.toHaveBeenCalled();
  });

  it("deletes when confirm: true is provided", async () => {
    prisma.group.findUnique.mockResolvedValue({
      id: "g1",
      emailAccountId: ctx.emailAccountId,
      _count: { items: 0 },
    } as never);
    prisma.group.delete.mockResolvedValue({ id: "g1" } as never);

    const result = await adminGroupsDelete(ctx, {
      groupId: "g1",
      confirm: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dryRun).toBe(false);
    expect(prisma.group.delete).toHaveBeenCalled();
  });

  it("returns NOT_FOUND when group deleted between dry-run and confirm", async () => {
    // First call (dry-run): group exists.
    prisma.group.findUnique.mockResolvedValueOnce({
      id: "g1",
      name: "g1",
      emailAccountId: ctx.emailAccountId,
      _count: { items: 0 },
    } as never);

    const dryRun = await adminGroupsDelete(ctx, { groupId: "g1" });
    expect(dryRun.ok).toBe(true);

    // Second call (confirm): group missing.
    prisma.group.findUnique.mockResolvedValueOnce(null as never);

    const confirmed = await adminGroupsDelete(ctx, {
      groupId: "g1",
      confirm: true,
    });
    expect(confirmed.ok).toBe(false);
    if (!confirmed.ok) expect(confirmed.error.code).toBe("NOT_FOUND");
  });

  it("returns VALIDATION_ERROR for missing groupId", async () => {
    const result = await adminGroupsDelete(ctx, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("adminGroupsAddItem + adminGroupsRemoveItem", () => {
  it("adds an item then removes it", async () => {
    prisma.group.findUnique.mockResolvedValue({
      id: "g1",
      emailAccountId: ctx.emailAccountId,
    } as never);
    prisma.groupItem.create.mockResolvedValue({
      id: "item_new",
      type: GroupItemType.FROM,
      value: "newsletter@co.com",
      exclude: false,
    } as never);
    vi.mocked(isDuplicateError).mockReturnValue(false);

    const added = await adminGroupsAddItem(ctx, {
      groupId: "g1",
      type: GroupItemType.FROM,
      value: "newsletter@co.com",
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    prisma.groupItem.findUnique.mockResolvedValue({
      id: "item_new",
      group: { emailAccountId: ctx.emailAccountId },
    } as never);
    prisma.groupItem.delete.mockResolvedValue({ id: "item_new" } as never);

    const removed = await adminGroupsRemoveItem(ctx, { itemId: "item_new" });
    expect(removed.ok).toBe(true);
    if (removed.ok && removed.data) {
      expect((removed.data as { deletedItemId: string }).deletedItemId).toBe(
        "item_new",
      );
    }
  });

  it("returns VALIDATION_ERROR for missing fields on add", async () => {
    const result = await adminGroupsAddItem(ctx, { groupId: "g1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns NOT_FOUND for foreign item on remove", async () => {
    prisma.groupItem.findUnique.mockResolvedValue({
      id: "item_1",
      group: { emailAccountId: "other_account" },
    } as never);
    const result = await adminGroupsRemoveItem(ctx, { itemId: "item_1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });
});

import { getTool, hasRequiredScope } from "./registry";

describe("registry integration", () => {
  it.each([
    "admin_groups_list",
    "admin_groups_get",
    "admin_groups_create",
    "admin_groups_update",
    "admin_groups_delete",
    "admin_groups_add_item",
    "admin_groups_remove_item",
  ])("registers %s with admin scope", (name) => {
    const tool = getTool(name);
    expect(tool).toBeDefined();
    expect(tool?.requiredScope).toBe("admin");
    expect(hasRequiredScope(tool!, ["admin"])).toBe(true);
    expect(hasRequiredScope(tool!, ["email:read"])).toBe(false);
  });

  it("runs admin_groups_list end-to-end through registry handler", async () => {
    prisma.group.findMany.mockResolvedValue([] as never);

    const tool = getTool("admin_groups_list");
    expect(tool).toBeDefined();
    const result = await tool!.handler(ctx, {});
    expect(result).toEqual({ ok: true, data: { groups: [] } });
  });
});
