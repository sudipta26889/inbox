import { describe, expect, it, vi } from "vitest";
import {
  A2A_BODY_LIMIT,
  AUTH_BODY_LIMIT,
  bodyTooLargeResponse,
  MCP_BODY_LIMIT,
  MCP_PUBLIC_FORM_LIMIT,
  readBodyWithLimit,
  readJsonWithLimit,
  rebuildRequest,
} from "./request-body-limit";

const URL = "http://localhost/test";

describe("limits", () => {
  it("uses the agreed sizes", () => {
    expect(AUTH_BODY_LIMIT).toBe(65_536);
    expect(MCP_PUBLIC_FORM_LIMIT).toBe(16_384);
    expect(MCP_BODY_LIMIT).toBe(
      Math.ceil((25 * 1024 * 1024 * 4) / 3) + 1024 * 1024,
    );
    expect(A2A_BODY_LIMIT).toBe(MCP_BODY_LIMIT);
  });
});

describe("readBodyWithLimit", () => {
  it("returns the bytes of a body under the limit", async () => {
    const result = await readBodyWithLimit(post("hello"), 10);

    expect(result.ok && new TextDecoder().decode(result.bytes)).toBe("hello");
  });

  it("accepts a body of exactly the limit", async () => {
    const result = await readBodyWithLimit(post("x".repeat(10)), 10);

    expect(result.ok && result.bytes.byteLength).toBe(10);
  });

  it("returns empty bytes when there is no body", async () => {
    const request = new Request(URL, { method: "POST" });

    const result = await readBodyWithLimit(request, 10);

    expect(result.ok && result.bytes.byteLength).toBe(0);
  });

  it("stops reading a chunked body with no Content-Length at the limit", async () => {
    let chunksPulled = 0;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          chunksPulled++;
          controller.enqueue(new Uint8Array(1024));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const request = streamed(stream);
    expect(request.headers.get("content-length")).toBeNull();

    const result = await readBodyWithLimit(request, 4 * 1024);

    expect(result).toEqual({ ok: false, status: 413 });
    expect(chunksPulled).toBe(5);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("enforces the limit on bytes read, not on the declared Content-Length", async () => {
    const request = post("x".repeat(100), { "Content-Length": "5" });

    const result = await readBodyWithLimit(request, 10);

    expect(result).toEqual({ ok: false, status: 413 });
  });
});

describe("readJsonWithLimit", () => {
  it("parses JSON under the limit", async () => {
    const result = await readJsonWithLimit(post('{"a":"é"}'), 100);

    expect(result).toEqual({ ok: true, value: { a: "é" } });
  });

  it("returns 400 for invalid JSON", async () => {
    const result = await readJsonWithLimit(post("{nope"), 100);

    expect(result).toEqual({ ok: false, status: 400 });
  });

  it("returns 413 over the limit without parsing", async () => {
    const result = await readJsonWithLimit(post("{nope".repeat(10)), 10);

    expect(result).toEqual({ ok: false, status: 413 });
  });

  it("handles a body larger than a 20 MB attachment encoded as base64", async () => {
    const attachment = Buffer.alloc(20 * 1024 * 1024, 1).toString("base64");

    const result = await readJsonWithLimit(
      post(JSON.stringify({ attachment })),
      MCP_BODY_LIMIT,
    );

    expect(result).toEqual({ ok: true, value: { attachment } });
  });
});

describe("rebuildRequest", () => {
  it("keeps method, URL, headers and bytes", async () => {
    const body = '{"a":1}';
    const request = post(body, {
      "Content-Type": "application/json",
      "Content-Length": String(body.length),
      Cookie: "a=b",
    });

    const rebuilt = rebuildRequest(request, new TextEncoder().encode(body));

    expect(rebuilt.method).toBe("POST");
    expect(rebuilt.url).toBe(URL);
    expect(Object.fromEntries(rebuilt.headers)).toEqual(
      Object.fromEntries(request.headers),
    );
    expect(await rebuilt.json()).toEqual({ a: 1 });
  });

  it("works for a request that arrived as a stream", async () => {
    const request = streamed(new Response('{"a":1}').body!);

    const result = await readBodyWithLimit(request, 100);
    if (!result.ok) throw new Error("expected body");

    expect(await rebuildRequest(request, result.bytes).json()).toEqual({
      a: 1,
    });
  });

  it("passes an empty body through as an empty body", async () => {
    const rebuilt = rebuildRequest(post("x"), new Uint8Array());

    expect(rebuilt.body).not.toBeNull();
    expect(await rebuilt.text()).toBe("");
  });

  it("can parse urlencoded and multipart forms", async () => {
    const urlencoded = rebuildRequest(
      post("", { "Content-Type": "application/x-www-form-urlencoded" }),
      new TextEncoder().encode("a=1"),
    );
    expect((await urlencoded.formData()).get("a")).toBe("1");

    const form = new FormData();
    form.set("a", "2");
    const original = new Request(URL, { method: "POST", body: form });
    const result = await readBodyWithLimit(original.clone(), 1024);
    if (!result.ok) throw new Error("expected body");
    expect(
      (await rebuildRequest(original, result.bytes).formData()).get("a"),
    ).toBe("2");
  });
});

describe("bodyTooLargeResponse", () => {
  it("is a 413 JSON response that closes the connection", async () => {
    const response = bodyTooLargeResponse(
      { error: "too large" },
      { "X-Other": "kept" },
    );

    expect(response.status).toBe(413);
    expect(response.headers.get("connection")).toBe("close");
    expect(response.headers.get("x-other")).toBe("kept");
    expect(await response.json()).toEqual({ error: "too large" });
  });
});

function post(body: string, headers?: Record<string, string>) {
  return new Request(URL, { method: "POST", body, headers });
}

function streamed(body: ReadableStream<Uint8Array>) {
  return new Request(URL, {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit);
}
