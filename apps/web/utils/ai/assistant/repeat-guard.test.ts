import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createScopedLogger } from "@/utils/logger";
import { withRepeatGuard } from "./repeat-guard";

const logger = createScopedLogger("repeat-guard-test");

function toolset(execute: ReturnType<typeof vi.fn>) {
  return withRepeatGuard({ searchInbox: { execute } as any }, logger);
}

const call = (tools: any, input: unknown) =>
  tools.searchInbox.execute(input, {});

describe("repeat guard", () => {
  /**
   * The failure this exists for: seven consecutive identical search_inbox
   * calls, budget exhausted, no answer. A retry can be honest, so two run.
   */
  it("refuses a third identical call and says why", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const tools = toolset(execute);

    await call(tools, { query: "unread" });
    await call(tools, { query: "unread" });
    const third = await call(tools, { query: "unread" });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(third).toMatchObject({ repeated: true });
    expect(third.guidance).toMatch(/do not call it again/i);
  });

  it("lets a genuinely different call through", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const tools = toolset(execute);

    await call(tools, { query: "unread" });
    await call(tools, { query: "unread" });
    await call(tools, { query: "from:boss" });

    expect(execute).toHaveBeenCalledTimes(3);
  });

  // Key order varies between turns; it is still the same call.
  it("treats reordered arguments as the same call", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const tools = toolset(execute);

    await call(tools, { query: "unread", limit: 5 });
    await call(tools, { limit: 5, query: "unread" });
    await call(tools, { query: "unread", limit: 5 });

    expect(execute).toHaveBeenCalledTimes(2);
  });

  /**
   * Loop-local, not global. Each run gets a fresh ledger, or a question asked
   * twice in a day would be refused the second time.
   */
  it("starts each run with a clean ledger", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });

    for (let run = 0; run < 2; run++) {
      const tools = toolset(execute);
      await call(tools, { query: "unread" });
      await call(tools, { query: "unread" });
      await call(tools, { query: "unread" });
    }

    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("leaves a tool with no execute alone", () => {
    const tools = withRepeatGuard({ providerTool: {} as any }, logger);

    expect(tools.providerTool).toBeDefined();
  });
});
