export const AUTH_BODY_LIMIT = 64 * 1024;
export const MCP_PUBLIC_FORM_LIMIT = 16 * 1024;

// 25 MB is Gmail's message size limit and base64 grows it by 4/3. Attachments
// have no smaller enforced maximum, so this is the largest useful JSON body.
const GMAIL_MESSAGE_JSON_LIMIT =
  Math.ceil((25 * 1024 * 1024 * 4) / 3) + 1024 * 1024;
export const MCP_BODY_LIMIT = GMAIL_MESSAGE_JSON_LIMIT;
export const A2A_BODY_LIMIT = GMAIL_MESSAGE_JSON_LIMIT;

export async function readBodyWithLimit(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; status: 413 }> {
  if (!request.body) return { ok: true, bytes: new Uint8Array() };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) return { ok: true, bytes: Buffer.concat(chunks, totalBytes) };

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      // Not awaited: the response must not wait on the sender.
      reader.cancel().catch(() => {});
      return { ok: false, status: 413 };
    }
    chunks.push(value);
  }
}

export async function readJsonWithLimit(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; status: 413 | 400 }> {
  const body = await readBodyWithLimit(request, maxBytes);
  if (!body.ok) return body;

  try {
    return {
      ok: true,
      value: JSON.parse(new TextDecoder().decode(body.bytes)),
    };
  } catch {
    return { ok: false, status: 400 };
  }
}

/** Same method, URL, headers and bytes as the request whose body was consumed. */
export function rebuildRequest(request: Request, bytes: Uint8Array): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bytes as BodyInit,
  });
}

/**
 * Reading stopped at the limit, so unread body bytes may remain on the socket.
 * Reusing that connection would leave the next request waiting forever.
 */
export function bodyTooLargeResponse(
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return Response.json(body, {
    status: 413,
    headers: { ...headers, Connection: "close" },
  });
}
