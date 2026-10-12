import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sendPinnedWebhookRequest } from "./webhook-request";

describe("sendPinnedWebhookRequest", () => {
  let server: Server;
  let port: number;
  let hits: { path: string; body: string }[];

  beforeEach(async () => {
    hits = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        hits.push({ path: req.url ?? "", body });
        if (req.url === "/redirect") {
          res.writeHead(302, { Location: "/internal-admin" });
          res.end();
          return;
        }
        res.writeHead(200);
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("connects to the vetted address without resolving the hostname again", async () => {
    // .invalid never resolves, so this only arrives via the pinned address.
    const result = await sendPinnedWebhookRequest({
      url: `http://webhook-target.invalid:${port}/hook`,
      addresses: ["127.0.0.1"],
      body: '{"ok":true}',
      headers: { "Content-Type": "application/json" },
    });

    expect(result.statusCode).toBe(200);
    expect(hits).toEqual([{ path: "/hook", body: '{"ok":true}' }]);
  });

  it("does not follow redirects", async () => {
    const result = await sendPinnedWebhookRequest({
      url: `http://webhook-target.invalid:${port}/redirect`,
      addresses: ["127.0.0.1"],
      body: "{}",
      headers: {},
    });

    expect(result.statusCode).toBe(302);
    expect(hits.map((hit) => hit.path)).toEqual(["/redirect"]);
  });

  it("refuses to connect without a vetted address", async () => {
    await expect(
      sendPinnedWebhookRequest({
        url: `http://webhook-target.invalid:${port}/hook`,
        addresses: [],
        body: "{}",
        headers: {},
      }),
    ).rejects.toThrow("No vetted address to connect to");
    expect(hits).toEqual([]);
  });
});
