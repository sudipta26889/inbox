import { betterAuth } from "better-auth";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { betterAuthConfig } from "@/utils/auth";
import { GET, POST } from "./route";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/auth", () => ({
  betterAuthConfig: { handler: vi.fn() },
}));

const handler = vi.mocked(betterAuthConfig.handler);
const URL = "http://localhost/api/auth/sign-in/social";

describe("auth route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handler.mockResolvedValue(new Response("ok"));
  });

  it("refuses a POST body over 64 KB without calling better-auth", async () => {
    const response = await POST(post("x".repeat(64 * 1024 + 1)));

    expect(response.status).toBe(413);
    expect(response.headers.get("connection")).toBe("close");
    expect(await response.json()).toEqual({ error: "Request body too large" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses an oversized POST sent as a stream with no Content-Length", async () => {
    const stream = new Response("x".repeat(64 * 1024 + 1)).body!;
    const request = new NextRequest(URL, {
      method: "POST",
      body: stream,
      duplex: "half",
    } as ConstructorParameters<typeof NextRequest>[1]);

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });

  it("hands better-auth the same method, URL, headers and JSON", async () => {
    const body = JSON.stringify({ provider: "google", callbackURL: "/é" });
    const request = post(body, {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
      Cookie: "session=abc",
      Origin: "http://localhost",
    });
    const expectedHeaders = Object.fromEntries(request.headers);

    const response = await POST(request);

    expect(response.status).toBe(200);
    const forwarded = handler.mock.calls[0][0];
    expect(forwarded.method).toBe("POST");
    expect(forwarded.url).toBe(URL);
    expect(Object.fromEntries(forwarded.headers)).toEqual(expectedHeaders);
    expect(await forwarded.json()).toEqual(JSON.parse(body));
  });

  it("hands better-auth an empty body when the POST stream is empty", async () => {
    const request = new NextRequest(URL, {
      method: "POST",
      body: new Response("").body,
      duplex: "half",
    } as ConstructorParameters<typeof NextRequest>[1]);

    await POST(request);

    const forwarded = handler.mock.calls[0][0];
    expect(forwarded.body).not.toBeNull();
    expect(await forwarded.text()).toBe("");
  });

  describe("with the real better-auth handler", () => {
    beforeEach(() => {
      const realAuth = betterAuth({
        baseURL: "http://localhost",
        secret: "x".repeat(40),
        trustedOrigins: ["http://localhost"],
        socialProviders: {
          google: { clientId: "client-id", clientSecret: "client-secret" },
        },
        logger: { disabled: true },
      });
      handler.mockImplementation(realAuth.handler);
    });

    it("starts a social sign-in from the forwarded JSON", async () => {
      const response = await POST(
        post(JSON.stringify({ provider: "google", callbackURL: "/" }), {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        }),
      );

      expect(response.status).toBe(200);
      expect((await response.json()).url).toContain("accounts.google.com");
    });

    it("rejects an empty JSON sign-out", async () => {
      const request = new NextRequest("http://localhost/api/auth/sign-out", {
        method: "POST",
        body: new Response("").body,
        duplex: "half",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
      } as ConstructorParameters<typeof NextRequest>[1]);

      const response = await POST(request);

      expect(response.status).toBe(400);
    });
  });

  it("passes GET through to better-auth untouched", async () => {
    const request = new NextRequest(URL);

    await GET(request);

    expect(handler.mock.calls[0][0]).toBe(request);
  });
});

function post(body: string, headers?: Record<string, string>) {
  return new NextRequest(URL, { method: "POST", body, headers });
}
