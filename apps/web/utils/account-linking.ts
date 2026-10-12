import type { GetAuthLinkUrlResponse } from "@/app/api/google/linking/auth-url/route";
import type { GetOutlookAuthLinkUrlResponse } from "@/app/api/outlook/linking/auth-url/route";
import { isGoogleProvider } from "@/utils/email/provider-types";

/**
 * Initiates the OAuth account linking flow for Google or Microsoft.
 * Returns the OAuth URL to redirect the user to.
 *
 * Pass `reconnectEmailAccountId` when refreshing an existing mailbox so the
 * provider is asked for that identity and the callback rejects a different one.
 * Omit it when adding a new account.
 * @throws Error if the request fails
 */
export async function getAccountLinkingUrl(
  provider: "google" | "microsoft",
  options?: { reconnectEmailAccountId?: string },
): Promise<string> {
  const apiProvider = provider === "microsoft" ? "outlook" : "google";
  const query = options?.reconnectEmailAccountId
    ? `?emailAccountId=${encodeURIComponent(options.reconnectEmailAccountId)}`
    : "";

  const response = await fetch(`/api/${apiProvider}/linking/auth-url${query}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to initiate ${isGoogleProvider(provider) ? "Google" : "Microsoft"} account linking`,
    );
  }

  const data: GetAuthLinkUrlResponse | GetOutlookAuthLinkUrlResponse =
    await response.json();

  return data.url;
}
