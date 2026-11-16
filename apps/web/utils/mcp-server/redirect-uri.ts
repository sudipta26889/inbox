import { SafeError } from "@/utils/error";
import { LOOPBACK_HOSTS } from "./constants";

const CUSTOM_SCHEMES = [
  "claude:",
  "cursor:",
  "vscode:",
  "vscode-insiders:",
  "windsurf:",
];

/**
 * Format check for a redirect_uri: https, http on a loopback host, or one of
 * the custom schemes the known desktop clients use.
 */
export function validateRedirectUri(redirectUri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new SafeError("Invalid redirect_uri format");
  }

  const allowed =
    parsed.protocol === "https:" ||
    (parsed.protocol === "http:" && LOOPBACK_HOSTS.includes(parsed.hostname)) ||
    CUSTOM_SCHEMES.includes(parsed.protocol);
  if (!allowed) {
    throw new SafeError(
      "redirect_uri must use HTTPS, a loopback host, or a known client scheme",
    );
  }
}

/**
 * Whether `requested` equals one of the registered URIs. Scheme, path and
 * query match exactly. Loopback is the one exception (RFC 8252 section 7.3):
 * native clients pick a fresh port per launch, so for http on a loopback host
 * the host may be any loopback name and the port may differ or be absent.
 */
export function redirectUriMatches(
  requested: string,
  registered: string[],
): boolean {
  const requestedUrl = parse(requested);
  if (!requestedUrl) return false;

  return registered.some((candidate) => {
    const registeredUrl = parse(candidate);
    if (!registeredUrl) return false;

    if (requested === candidate) return true;
    if (
      requestedUrl.protocol !== registeredUrl.protocol ||
      requestedUrl.pathname !== registeredUrl.pathname ||
      requestedUrl.search !== registeredUrl.search
    ) {
      return false;
    }

    return (
      requestedUrl.protocol === "http:" &&
      LOOPBACK_HOSTS.includes(requestedUrl.hostname) &&
      LOOPBACK_HOSTS.includes(registeredUrl.hostname)
    );
  });
}

function parse(uri: string): URL | null {
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}
