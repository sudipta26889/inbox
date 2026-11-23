import PQueue from "p-queue";
import type { Logger } from "@/utils/logger";

export const FLINT_MODEL_NAME = "recursivesi/flint";
// Reasoning counts against the cap; a smaller one makes Flint answer empty.
export const FLINT_MAX_OUTPUT_TOKENS = 8192;
// A call that has not started after this long is deferred ("later"). Long
// enough for a draft, whose five calls run one after another.
export const FLINT_MAX_WAIT_MS = 30 * 60 * 1000;

// All production model calls run in the single web process, so an in-process
// queue is enough to keep one call in flight. Created on the first Flint call:
// PQueue is an EventTarget, which fails to construct in the jsdom test
// environment that imports this module indirectly.
let flintQueue: PQueue | undefined;

function getFlintQueue() {
  flintQueue ??= new PQueue({ concurrency: 1 });
  return flintQueue;
}

/**
 * The call waited too long for its turn. Thrown so the caller treats the
 * request as "later" (see `isLlmUnavailableError`).
 */
export class FlintBusyError extends Error {
  constructor() {
    super("Flint is busy with other calls, try again later");
    this.name = "FlintBusyError";
  }
}

export function isFlintModel(modelName: string) {
  return modelName === FLINT_MODEL_NAME;
}

/**
 * Flint serves about 40 tokens/s across all apps, so Inbox runs one batch
 * call at a time: parallel calls wait their turn, in order. Wraps the model
 * call itself, under the retry wrappers, so their backoff does not hold the
 * slot. Interactive calls and other models pass straight through.
 */
export async function withFlintStream<T>({
  modelName,
  interactive,
  label,
  logger,
  run,
}: {
  modelName: string;
  interactive?: boolean;
  label: string;
  logger: Logger;
  run: () => Promise<T>;
}): Promise<T> {
  if (!isFlintModel(modelName) || interactive) return run();

  const queuedAt = Date.now();
  const waitController = new AbortController();
  const waitTimer = setTimeout(
    () => waitController.abort(new FlintBusyError()),
    FLINT_MAX_WAIT_MS,
  );

  try {
    // p-queue skips a task whose signal aborts before it starts and rejects
    // with the signal's reason; once started the timer is gone, so the run
    // itself has no cap.
    return (await getFlintQueue().add(
      async () => {
        clearTimeout(waitTimer);
        const startedAt = Date.now();
        let completionTokens: number | undefined;
        try {
          const result = await run();
          completionTokens = (
            result as { usage?: { outputTokens?: number } } | null
          )?.usage?.outputTokens;
          return result;
        } finally {
          logger.info("Flint call", {
            label,
            completionTokens,
            waitedSeconds: toSeconds(startedAt - queuedAt),
            seconds: toSeconds(Date.now() - startedAt),
          });
        }
      },
      { signal: waitController.signal },
    )) as T;
  } catch (error) {
    if (error instanceof FlintBusyError) {
      logger.info("Flint queue wait exceeded, skipping call", {
        label,
        waitedSeconds: toSeconds(Date.now() - queuedAt),
      });
    }
    throw error;
  } finally {
    clearTimeout(waitTimer);
  }
}

function toSeconds(ms: number) {
  return Math.round(ms / 100) / 10;
}
