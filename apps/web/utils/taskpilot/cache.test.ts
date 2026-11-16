import { describe, expect, it, vi } from "vitest";
import { TaskpilotCache } from "@/utils/taskpilot/cache";

describe("TaskpilotCache.getProjects", () => {
  it("caches the loader result for the TTL window", async () => {
    const loader = vi
      .fn()
      .mockResolvedValue([{ id: "p1", identifier: "WEB", name: "Web" }]);
    const cache = new TaskpilotCache({ ttlMs: 1000 });
    const first = await cache.getProjects("user-1", loader);
    const second = await cache.getProjects("user-1", loader);
    expect(first).toEqual(second);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("calls the loader again after TTL expiry", async () => {
    vi.useFakeTimers();
    const loader = vi
      .fn()
      .mockResolvedValue([{ id: "p1", identifier: "WEB", name: "Web" }]);
    const cache = new TaskpilotCache({ ttlMs: 1000 });
    await cache.getProjects("user-1", loader);
    vi.advanceTimersByTime(1500);
    await cache.getProjects("user-1", loader);
    expect(loader).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("invalidates a user's caches via invalidateUser", async () => {
    const loader = vi
      .fn()
      .mockResolvedValue([{ id: "p1", identifier: "WEB", name: "Web" }]);
    const cache = new TaskpilotCache({ ttlMs: 60_000 });
    await cache.getProjects("user-1", loader);
    cache.invalidateUser("user-1");
    await cache.getProjects("user-1", loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe("TaskpilotCache.getLabels", () => {
  it("scopes by (userId, projectId)", async () => {
    const loader = vi
      .fn()
      .mockImplementation(async (projectId: string) => [
        { id: `l-${projectId}`, name: `label-${projectId}` },
      ]);
    const cache = new TaskpilotCache({ ttlMs: 60_000 });
    const a = await cache.getLabels("user-1", "p1", () => loader("p1"));
    const b = await cache.getLabels("user-1", "p2", () => loader("p2"));
    expect(a[0].name).toBe("label-p1");
    expect(b[0].name).toBe("label-p2");
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
