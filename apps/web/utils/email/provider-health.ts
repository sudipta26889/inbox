import {
  getErrorMessage,
  isGmailInsufficientPermissionsError,
} from "@/utils/error";

type ProviderIssue = {
  reason:
    | "insufficient_permissions"
    | "policy_enforced"
    | "mail_service_not_enabled"
    | "invalid_grant";
};

// Errors that mean every further call for this account will fail the same way
// until it is reconnected.
export function classifyEmailAccountProviderIssue({
  error,
  provider,
}: {
  error: unknown;
  provider: "google" | "microsoft";
}): ProviderIssue | null {
  const message = getErrorMessage(error);

  if (
    provider === "google" &&
    (isGmailInsufficientPermissionsError(error) ||
      message?.includes("Request had insufficient authentication scopes"))
  ) {
    return { reason: "insufficient_permissions" };
  }

  if (
    provider === "google" &&
    (message?.includes("policy_enforced") ||
      message?.includes("Advanced Protection prevented your Google Account"))
  ) {
    return { reason: "policy_enforced" };
  }

  if (provider === "google" && message?.includes("Mail service not enabled")) {
    return { reason: "mail_service_not_enabled" };
  }

  if (
    message?.includes("invalid_grant") ||
    message?.includes("No refresh token")
  ) {
    return { reason: "invalid_grant" };
  }

  return null;
}
