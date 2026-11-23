import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import {
  FLINT_MAX_OUTPUT_TOKENS,
  FLINT_MAX_WAIT_MS,
  FLINT_MODEL_NAME,
  FlintBusyError,
  withFlintStream,
} from "./flint-stream";

const logger = createTestLogger();

function deferred<T = string>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flint<T>(run: () => Promise<T>, label = "test") {
  return withFlintStream({ modelName: FLINT_MODEL_NAME, label, logger, run });
}

describe("withFlintStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs two concurrent calls one after the other", async () => {
    const first = deferred();
    const events: string[] = [];

    const a = flint(async () => {
      events.push("a start");
      const value = await first.promise;
      events.push("a end");
      return value;
    });
    const b = flint(async () => {
      events.push("b start");
      return "b";
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual(["a start"]);

    first.resolve("a");
    await expect(a).resolves.toBe("a");
    await expect(b).resolves.toBe("b");
    expect(events).toEqual(["a start", "a end", "b start"]);
  });

  it("runs five parallel calls (the draft shape) in order, never two at once", async () => {
    let running = 0;
    let maxRunning = 0;
    const order: number[] = [];

    const calls = [1, 2, 3, 4, 5].map((n) =>
      flint(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        order.push(n);
        running--;
        return n;
      }),
    );

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(Promise.all(calls)).resolves.toEqual([1, 2, 3, 4, 5]);
    expect(order).toEqual([1, 2, 3, 4, 5]);
    expect(maxRunning).toBe(1);
  });

  it("drops a call that waited past the cap, never runs it, and keeps working", async () => {
    const first = deferred();
    const skipped = vi.fn().mockResolvedValue("never");

    const a = flint(() => first.promise);
    const b = flint(skipped);
    const bResult = b.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(FLINT_MAX_WAIT_MS + 1000);

    expect(await bResult).toBeInstanceOf(FlintBusyError);
    expect(skipped).not.toHaveBeenCalled();

    first.resolve("a");
    await expect(a).resolves.toBe("a");

    const later = vi.fn().mockResolvedValue("c");
    await expect(flint(later)).resolves.toBe("c");
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("does not cap the run itself", async () => {
    const run = deferred();
    const a = flint(() => run.promise);

    await vi.advanceTimersByTimeAsync(FLINT_MAX_WAIT_MS * 2);
    run.resolve("done");

    await expect(a).resolves.toBe("done");
  });

  it("frees the slot when a call throws", async () => {
    const a = flint(async () => {
      throw new Error("boom");
    });
    const b = flint(async () => "b");

    await expect(a).rejects.toThrow("boom");
    await expect(b).resolves.toBe("b");
  });

  it("does not make interactive calls wait", async () => {
    const first = deferred();
    const a = flint(() => first.promise);

    const result = await withFlintStream({
      modelName: FLINT_MODEL_NAME,
      interactive: true,
      label: "chat",
      logger,
      run: async () => "chat answer",
    });

    expect(result).toBe("chat answer");
    first.resolve("a");
    await a;
  });

  it("does not make calls to other models wait", async () => {
    const first = deferred();
    const a = flint(() => first.promise);

    const result = await withFlintStream({
      modelName: "gpt-oss-20b",
      label: "other",
      logger,
      run: async () => "other",
    });

    expect(result).toBe("other");
    first.resolve("a");
    await a;
  });

  it("logs label, completion tokens, wait and run seconds, no content", async () => {
    const info = vi.spyOn(logger, "info");
    const first = deferred();

    const a = flint(() => first.promise, "first");
    const b = flint(
      async () => ({ usage: { outputTokens: 321 } }),
      "draft-reply",
    );

    await vi.advanceTimersByTimeAsync(3000);
    first.resolve("a");
    await a;
    await b;

    expect(info).toHaveBeenCalledWith(
      "Flint call",
      expect.objectContaining({
        label: "draft-reply",
        completionTokens: 321,
        waitedSeconds: 3,
        seconds: expect.any(Number),
      }),
    );
  });

  it("logs when a call is dropped after waiting too long", async () => {
    const info = vi.spyOn(logger, "info");
    const first = deferred();

    const a = flint(() => first.promise);
    const b = flint(async () => "b", "rule-choice").catch(() => undefined);

    await vi.advanceTimersByTimeAsync(FLINT_MAX_WAIT_MS + 1000);
    await b;
    first.resolve("a");
    await a;

    expect(info).toHaveBeenCalledWith(
      "Flint queue wait exceeded, skipping call",
      expect.objectContaining({ label: "rule-choice" }),
    );
  });

  it("exposes the default output cap", () => {
    expect(FLINT_MAX_OUTPUT_TOKENS).toBe(8192);
  });
});
