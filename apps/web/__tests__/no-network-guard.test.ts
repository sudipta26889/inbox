import http from "node:http";
import https from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAllowedTestHost } from "./no-network-guard";

// The guard is installed by the vitest setup file for every unit test. It is
// not installed for the AI eval and e2e suites, which need the network.
const guardActive =
  process.env.RUN_AI_TESTS !== "true" &&
  process.env.RUN_E2E_TESTS !== "true" &&
  process.env.RUN_E2E_FLOW_TESTS !== "true";

describe.skipIf(!guardActive)("unit tests cannot reach a real host", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    "https://taskpilot-api.sudiptadhara.in/api/v1/x",
    "http://example.com/",
    "https://8.8.8.8/",
  ])("fetch to %s is refused", async (url) => {
    await expect(fetch(url)).rejects.toThrow(
      /Unit test tried to reach a real host: .* — stub fetch or inject a client/,
    );
  });

  it("names the origin of a refused request", async () => {
    await expect(fetch("https://example.com/secret?q=1")).rejects.toThrow(
      "Unit test tried to reach a real host: https://example.com — stub fetch or inject a client",
    );
  });

  it("refuses a Request and a URL object too", async () => {
    await expect(fetch(new Request("https://example.com/"))).rejects.toThrow(
      /real host/,
    );
    await expect(fetch(new URL("https://example.com/"))).rejects.toThrow(
      /real host/,
    );
  });

  it("does not refuse localhost, 127.0.0.1, ::1 or *.test (they fail to connect instead)", async () => {
    for (const url of [
      "http://localhost:9/",
      "http://127.0.0.1:9/",
      "http://[::1]:9/",
      "http://taskpilot.test/",
    ]) {
      await expect(fetch(url)).rejects.not.toThrow(/real host/);
    }
  });

  it("lets data: URLs through", async () => {
    const response = await fetch("data:text/plain,hello");

    expect(await response.text()).toBe("hello");
  });

  it("a stubbed fetch keeps working, whatever the host", async () => {
    const stub = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", stub);

    const response = await fetch("https://taskpilot-api.sudiptadhara.in/x");

    expect(await response.text()).toBe("ok");
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("a spy on fetch keeps working", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("spied"));

    expect(await (await fetch("https://example.com/")).text()).toBe("spied");

    spy.mockRestore();
  });

  it("http and https requests to a real host throw", () => {
    expect(() => http.get("http://example.com/")).toThrow(/real host/);
    expect(() => https.request("https://example.com/")).toThrow(/real host/);
    expect(() => https.request({ hostname: "example.com", path: "/" })).toThrow(
      /real host/,
    );
  });

  it("the production TaskPilot host is not the test base URL", () => {
    expect(process.env.TASKPILOT_API_BASE_URL).toBe("http://taskpilot.test");
  });
});

describe("isAllowedTestHost", () => {
  it.each([
    ["localhost", true],
    ["LOCALHOST", true],
    ["127.0.0.1", true],
    ["::1", true],
    ["[::1]", true],
    ["taskpilot.test", true],
    ["app.localhost", true],
    ["example.com", false],
    ["test.example.com", false],
    ["notlocalhost.com", false],
    ["evil.test.example.com", false],
    ["192.168.10.5", false],
    ["db.lan", false],
  ])("%s -> %s", (host, allowed) => {
    expect(isAllowedTestHost(host)).toBe(allowed);
  });
});
