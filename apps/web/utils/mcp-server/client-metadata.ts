import { lookup } from "node:dns/promises";
import https from "node:https";
import { BlockList } from "node:net";
import { SafeError } from "@/utils/error";
import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { redirectUriMatches, validateRedirectUri } from "./redirect-uri";

const logger = createScopedLogger("mcp-server/client-metadata");

const FETCH_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 64 * 1024;
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

const blockedAddresses = buildBlockList();

/**
 * Client ID Metadata Document support: a client whose client_id is an https URL
 * publishes its own registration there. The fetch goes to a URL the client
 * chose, so the address is checked before connecting and the connection is
 * pinned to the address that was checked.
 */
export async function resolveClientMetadata(
  clientIdUrl: string,
  requestedRedirectUri: string,
) {
  const url = parseClientIdUrl(clientIdUrl);

  const existing = await prisma.mcpServerClient.findUnique({
    where: { clientId: clientIdUrl },
  });
  if (
    existing &&
    Date.now() - existing.updatedAt.getTime() < REFRESH_AFTER_MS &&
    redirectUriMatches(requestedRedirectUri, existing.redirectUris)
  ) {
    return existing;
  }

  const { address, family } = await resolvePublicAddress(url.hostname);

  let document: unknown;
  try {
    document = await fetchPinnedJson(clientIdUrl, address, family);
  } catch (error) {
    logger.warn("Client metadata fetch failed", {
      clientIdUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new SafeError("Could not fetch the client's metadata document");
  }

  const metadata = validateDocument(
    document,
    clientIdUrl,
    requestedRedirectUri,
  );

  const data = {
    clientName: metadata.clientName ?? url.host,
    redirectUris: metadata.redirectUris,
    logoUri: metadata.logoUri,
    tokenEndpointAuthMethod: "none",
  };

  return prisma.mcpServerClient.upsert({
    where: { clientId: clientIdUrl },
    create: { clientId: clientIdUrl, type: "MCP", ...data },
    update: data,
  });
}

/**
 * GET the URL over TLS, connecting only to `address`. TLS still verifies the
 * certificate against the hostname. Redirects are never followed.
 */
export function fetchPinnedJson(
  url: string,
  address: string,
  family: 4 | 6,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "GET",
        headers: { Accept: "application/json" },
        timeout: FETCH_TIMEOUT_MS,
        lookup: ((
          _hostname: string,
          options: { all?: boolean },
          callback: (...args: any[]) => void,
        ) => {
          if (options?.all) callback(null, [{ address, family }]);
          else callback(null, address, family);
        }) as any,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          request.destroy();
          reject(new Error(`Unexpected status ${response.statusCode}`));
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            request.destroy();
            reject(new Error("Response body too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          clearTimeout(deadline);
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("Response is not JSON"));
          }
        });
        response.on("error", reject);
      },
    );

    // The idle timeout above resets on every byte, so a server trickling data
    // could hold the request open; this caps the whole exchange.
    const deadline = setTimeout(
      () => request.destroy(new Error("Timed out")),
      FETCH_TIMEOUT_MS,
    );
    request.on("close", () => clearTimeout(deadline));
    request.on("timeout", () => request.destroy(new Error("Timed out")));
    request.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    request.end();
  });
}

function parseClientIdUrl(clientIdUrl: string): URL {
  let url: URL;
  try {
    url = new URL(clientIdUrl);
  } catch {
    throw new SafeError("Invalid client_id URL");
  }

  if (
    url.protocol !== "https:" ||
    (url.port !== "" && url.port !== "443") ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new SafeError("Invalid client_id URL");
  }
  return url;
}

async function resolvePublicAddress(
  hostname: string,
): Promise<{ address: string; family: 4 | 6 }> {
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new SafeError("Could not resolve the client's metadata host");
  }

  if (addresses.length === 0) {
    throw new SafeError("Could not resolve the client's metadata host");
  }

  // One private address is enough to refuse: the resolver may hand it out later.
  for (const { address, family } of addresses) {
    if (isBlockedAddress(address, family)) {
      throw new SafeError("The client's metadata host is not allowed");
    }
  }

  const first = addresses[0];
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

function validateDocument(
  document: unknown,
  clientIdUrl: string,
  requestedRedirectUri: string,
) {
  if (typeof document !== "object" || document === null) {
    throw new SafeError("Invalid client metadata document");
  }
  const doc = document as Record<string, unknown>;

  if (doc.client_id !== clientIdUrl) {
    throw new SafeError("Client metadata client_id does not match its URL");
  }

  const redirectUris = doc.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    !redirectUris.every((uri): uri is string => typeof uri === "string")
  ) {
    throw new SafeError("Client metadata has no valid redirect_uris");
  }
  for (const uri of redirectUris) validateRedirectUri(uri);

  if (!redirectUriMatches(requestedRedirectUri, redirectUris)) {
    throw new SafeError("redirect_uri is not listed in the client's metadata");
  }

  const authMethod = doc.token_endpoint_auth_method;
  if (authMethod !== undefined && authMethod !== "none") {
    throw new SafeError("Only public clients (auth method none) are supported");
  }

  return {
    redirectUris,
    clientName:
      typeof doc.client_name === "string" && doc.client_name
        ? doc.client_name.slice(0, 100)
        : null,
    logoUri:
      typeof doc.logo_uri === "string" && doc.logo_uri.startsWith("https://")
        ? doc.logo_uri
        : null,
  };
}

// IPv4-mapped IPv6 is refused outright rather than unwrapped, so no spelling of
// an embedded private address can slip through. (A mapped subnet in the
// BlockList would match every IPv4 address, so it is checked here instead.)
function isBlockedAddress(address: string, family: number): boolean {
  if (family === 6 && /^(0{1,4}:){5}ffff:|^::ffff:/i.test(address)) return true;
  return blockedAddresses.check(address, family === 6 ? "ipv6" : "ipv4");
}

function buildBlockList() {
  const list = new BlockList();
  const v4: [string, number][] = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  for (const [network, prefix] of v4) list.addSubnet(network, prefix, "ipv4");

  list.addAddress("::", "ipv6");
  list.addAddress("::1", "ipv6");
  list.addSubnet("fc00::", 7, "ipv6");
  list.addSubnet("fe80::", 10, "ipv6");
  list.addSubnet("ff00::", 8, "ipv6");
  list.addSubnet("64:ff9b::", 96, "ipv6"); // NAT64: embeds an IPv4 address
  list.addSubnet("2002::", 16, "ipv6"); // 6to4: embeds an IPv4 address
  list.addSubnet("2001::", 32, "ipv6"); // Teredo
  list.addSubnet("fec0::", 10, "ipv6"); // deprecated site-local
  return list;
}
