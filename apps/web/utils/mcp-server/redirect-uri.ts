import { SafeError } from "@/utils/error";

/**
 * Format-only redirect_uri validation, shared by /authorize and /consent/approve.
 *
 * No strict match against the client's registered URIs: MCP clients
 * (LM Studio, Claude Desktop, etc.) register once but use a fresh random
 * localhost port per launch, so registered URIs rarely match. PKCE is
 * mandatory (OAuth 2.1), which protects the code exchange instead.
 */
export function validateRedirectUri(redirectUri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new SafeError("Invalid redirect_uri format");
  }

  const isLocalhost = ["localhost", "127.0.0.1"].includes(parsed.hostname);
  if (
    !isLocalhost &&
    parsed.protocol !== "https:" &&
    parsed.protocol !== "claude:"
  ) {
    throw new SafeError("redirect_uri must use HTTPS (except localhost)");
  }
}
