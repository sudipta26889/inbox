import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  type ResolvedSafeExternalHttpUrl,
  resolveSafeExternalHttpUrl,
} from "@inboxzero/network/safe-url";
import { normalizeHostname } from "@inboxzero/network/host-policy";
import { getRemoteAgentUrls } from "@/utils/a2a-client";

// Homelab and split-horizon suffixes that resolve only inside the network.
// The shared policy already blocks localhost, *.local, *.localhost and
// single-label names.
const INTERNAL_SUFFIXES = [".lan", ".internal", ".home.arpa", ".intranet"];
const MAX_RESPONSE_BYTES = 10_000;

/**
 * Vet a URL a peer (or the owner) asked us to POST to: https only, no internal
 * names, and every resolved address public (IPv4-mapped IPv6 included). Never
 * honours WEBHOOK_ALLOW_PRIVATE_IPS: these URLs come from A2A peers. The one
 * exception is an origin listed in A2A_REMOTE_AGENTS, which the operator set.
 * Returns the URL plus a lookup pinned to the vetted addresses, or null.
 */
export async function resolveA2aDestination(url: string): Promise<{
  url: URL;
  lookup?: ResolvedSafeExternalHttpUrl["lookup"];
} | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  // Operator-configured agents (Mitra on the LAN, plain http) are trusted by
  // exact origin: scheme, host and port. Another port on the same host is not.
  if (isConfiguredAgentOrigin(parsed)) return { url: parsed };

  if (parsed.protocol !== "https:") return null;

  const hostname = normalizeHostname(parsed.hostname);
  if (INTERNAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return null;
  }

  try {
    return await resolveSafeExternalHttpUrl(url, { allowPrivateIps: false });
  } catch {
    // Unresolvable is not deliverable.
    return null;
  }
}

export async function isAllowedA2aDestination(url: string) {
  return (await resolveA2aDestination(url)) !== null;
}

export type VettedPostResult =
  | { blocked: true }
  | { blocked: false; ok: boolean; status: number; body: string };

/**
 * POST to a URL re-vetted at send time, connecting only to the addresses that
 * passed the check (no DNS rebinding between check and connect). node:http(s)
 * never follows redirects, so a 3xx is a failed delivery, not a hop to
 * wherever the Location header points.
 */
export async function postToVettedUrl(
  url: string,
  {
    method = "POST",
    headers,
    body,
    timeoutMs,
  }: {
    method?: string;
    headers: Record<string, string>;
    body: string;
    timeoutMs: number;
  },
): Promise<VettedPostResult> {
  const destination = await resolveA2aDestination(url);
  if (!destination) return { blocked: true };

  const send =
    destination.url.protocol === "http:" ? httpRequest : httpsRequest;

  return new Promise((resolve, reject) => {
    const request = send(
      destination.url,
      {
        method,
        lookup: destination.lookup,
        headers: {
          ...headers,
          "Content-Length": Buffer.byteLength(body).toString(),
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (text.length < MAX_RESPONSE_BYTES) text += chunk;
        });
        response.on("error", reject);
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          resolve({
            blocked: false,
            ok: status >= 200 && status < 300,
            status,
            body: text.slice(0, MAX_RESPONSE_BYTES),
          });
        });
      },
    );
    request.setTimeout(timeoutMs, () =>
      request.destroy(new Error("Webhook request timed out")),
    );
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function isConfiguredAgentOrigin(url: URL) {
  return getRemoteAgentUrls().some((configured) => {
    try {
      return new URL(configured).origin === url.origin;
    } catch {
      return false;
    }
  });
}
