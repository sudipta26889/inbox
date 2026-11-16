import type { McpResult } from "./envelope";

/**
 * Run a destructive operation behind a dry-run gate.
 *
 * - When `confirm !== true`, runs `preview()` to compute a preview object
 *   (read-only side effects only) and returns `{ ok: true, dryRun: true,
 *   preview }`. The caller's preview function MUST NOT mutate.
 * - When `confirm === true`, skips `preview()` and runs `commit()`, wrapping
 *   the result in `{ ok: true, dryRun: false, data }`.
 *
 * The caller is responsible for catching domain errors thrown inside
 * `preview()` / `commit()` and translating them via `mapDomainError`.
 */
export async function withDryRunGate<T>(params: {
  confirm: boolean | undefined;
  preview: () => Promise<Record<string, unknown>>;
  commit: () => Promise<T>;
}): Promise<McpResult<T>> {
  if (params.confirm === true) {
    const data = await params.commit();
    return { ok: true, dryRun: false, data };
  }

  const preview = await params.preview();
  return { ok: true, dryRun: true, preview };
}
