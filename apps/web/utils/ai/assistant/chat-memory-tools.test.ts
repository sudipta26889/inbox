import { describe, expect, it, vi } from "vitest";
import { createScopedLogger } from "@/utils/logger";
import { saveMemoryTool } from "./chat-memory-tools";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

const logger = createScopedLogger("chat-memory-tools-test");

describe("saveMemoryTool description", () => {
  it("lists the account's existing subjects in the tool description", () => {
    const t = saveMemoryTool({
      email: "a@b.com",
      emailAccountId: "acct_1",
      logger,
      existingSubjects: ["digest.schedule", "courier.domestic"],
    });

    expect(t.description).toContain("digest.schedule");
    expect(t.description).toContain("courier.domestic");
  });

  it("omits the list when the account has no memories yet", () => {
    const t = saveMemoryTool({
      email: "a@b.com",
      emailAccountId: "acct_1",
      logger,
      existingSubjects: [],
    });

    // The negative control: an empty "Existing keys:" line reads as "there is a
    // closed vocabulary and it is empty", which is worse than saying nothing.
    expect(t.description).not.toContain("Existing keys");
  });
});
