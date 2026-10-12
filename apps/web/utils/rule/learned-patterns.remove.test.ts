import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { GroupItemSource, GroupItemType } from "@/generated/prisma/enums";
import { removeAiLearnedPattern } from "./learned-patterns";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

describe("removeAiLearnedPattern", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.groupItem.deleteMany.mockResolvedValue({ count: 1 });
  });

  it("only deletes AI-inferred include patterns, never user or exclusion entries", async () => {
    await removeAiLearnedPattern({
      emailAccountId: "ea-1",
      from: "News <News@Example.com>",
      ruleId: "custom-rule",
    });

    const { where } = prisma.groupItem.deleteMany.mock.calls[0][0]!;
    expect(where).toMatchObject({
      group: { emailAccountId: "ea-1", rule: { is: { id: "custom-rule" } } },
      type: GroupItemType.FROM,
      source: GroupItemSource.AI,
      exclude: false,
    });
    // Matches both the bare address and an older full-header value.
    expect(where?.OR).toEqual(
      expect.arrayContaining([
        { value: { equals: "News@Example.com", mode: "insensitive" } },
        { value: { endsWith: "<News@Example.com>", mode: "insensitive" } },
      ]),
    );
  });
});
