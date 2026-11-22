import { VoiceUnavailableError } from "@/utils/voice/errors";
import type {
  VoiceProvider as VoiceProviderAdapter,
  VoiceRuntimeConfig,
  VoiceStatus,
} from "@/utils/voice/types";

// Voice is off: dictation, spoken replies and live calls all sent audio or text
// to a cloud speech service. It comes back with a local speech model, which
// plugs in here as the provider.
export function resolveVoiceRuntime(): VoiceRuntimeConfig {
  return { enabled: false, providerId: null };
}

export function createVoiceProvider(
  _config: VoiceRuntimeConfig,
): VoiceProviderAdapter {
  throw new VoiceUnavailableError(
    "disabled",
    "Voice is turned off until a local speech model is set up.",
  );
}

export function toVoiceStatus(_config: VoiceRuntimeConfig): VoiceStatus {
  return {
    enabled: false,
    provider: null,
    providerName: null,
    transcribe: false,
    synthesize: false,
    live: false,
    ttsVoice: null,
    liveVoice: null,
  };
}

const VOICE_METHODS = {
  transcribe: "transcribe",
  synthesize: "synthesize",
  live: "createLiveSession",
} as const;

export function requireVoiceCapability<K extends keyof typeof VOICE_METHODS>(
  provider: VoiceProviderAdapter,
  capability: K,
): NonNullable<VoiceProviderAdapter[(typeof VOICE_METHODS)[K]]> {
  const methodName = VOICE_METHODS[capability];
  const method = provider[methodName];
  if (!provider.capabilities[capability] || typeof method !== "function") {
    throw new VoiceUnavailableError(
      "capability",
      capability === "live"
        ? "This voice provider does not support live conversations."
        : capability === "synthesize"
          ? "This voice provider does not speak replies."
          : "This voice provider does not transcribe audio.",
    );
  }
  return method.bind(provider) as NonNullable<
    VoiceProviderAdapter[(typeof VOICE_METHODS)[K]]
  >;
}
