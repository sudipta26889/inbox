import { describe, it, expect, vi } from "vitest";
import { withDryRunGate } from "./dry-run";

describe("withDryRunGate", () => {
  it("returns dryRun envelope and does NOT call commit when confirm is undefined", async () => {
    const commit = vi.fn();
    const preview = vi.fn().mockResolvedValue({ action: "delete", id: "r_1" });

    const out = await withDryRunGate({
      confirm: undefined,
      preview,
      commit,
    });

    expect(commit).not.toHaveBeenCalled();
    expect(preview).toHaveBeenCalledTimes(1);
    expect(out).toEqual({
      ok: true,
      dryRun: true,
      preview: { action: "delete", id: "r_1" },
    });
  });

  it("returns dryRun envelope and does NOT call commit when confirm is false", async () => {
    const commit = vi.fn();
    const preview = vi.fn().mockResolvedValue({ action: "delete" });

    const out = await withDryRunGate({
      confirm: false,
      preview,
      commit,
    });

    expect(commit).not.toHaveBeenCalled();
    expect(out).toEqual({
      ok: true,
      dryRun: true,
      preview: { action: "delete" },
    });
  });

  it("calls commit and wraps result when confirm is true", async () => {
    const commit = vi.fn().mockResolvedValue({ deleted: true, id: "r_1" });
    const preview = vi.fn();

    const out = await withDryRunGate({
      confirm: true,
      preview,
      commit,
    });

    expect(preview).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(out).toEqual({
      ok: true,
      dryRun: false,
      data: { deleted: true, id: "r_1" },
    });
  });
});
