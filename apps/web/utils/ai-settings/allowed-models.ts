import {
  DEFAULT_PROVIDER,
  Provider,
  providerOptions,
} from "@/utils/llms/config";

/**
 * The set of provider IDs accepted by `admin_ai_update_model`.
 * Same as `saveAiSettingsBody.aiProvider` in `settings.validation.ts`: mail is
 * personal data, so only the deployment default or the local models behind
 * LiteLLM may be saved, never a cloud provider.
 */
export const ALLOWED_AI_PROVIDERS = [
  DEFAULT_PROVIDER,
  Provider.LITELLM,
] as const;

export type AllowedAiProvider = (typeof ALLOWED_AI_PROVIDERS)[number];

export function isAllowedProvider(value: unknown): value is AllowedAiProvider {
  return (
    typeof value === "string" &&
    (ALLOWED_AI_PROVIDERS as readonly string[]).includes(value)
  );
}

/**
 * Human-readable provider options for MCP clients (label/value pairs).
 * Derived from the existing UI source-of-truth so this list never drifts.
 */
export function getProviderOptionsForMcp() {
  return providerOptions
    .filter((opt) =>
      (ALLOWED_AI_PROVIDERS as readonly string[]).includes(opt.value),
    )
    .map((opt) => ({ label: opt.label, value: opt.value }));
}
