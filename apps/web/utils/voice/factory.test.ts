import { describe, expect, it } from "vitest";
import {
  createVoiceProvider,
  requireVoiceCapability,
  resolveVoiceRuntime,
  toVoiceStatus,
} from "./factory";
import { VoiceUnavailableError } from "./errors";

describe("voice is off", () => {
  it("is disabled with no provider", () => {
    const config = resolveVoiceRuntime();
    expect(config).toMatchObject({ enabled: false, providerId: null });
  });

  it("reports nothing available, so no voice control is shown", () => {
    expect(toVoiceStatus(resolveVoiceRuntime())).toEqual({
      enabled: false,
      provider: null,
      providerName: null,
      transcribe: false,
      synthesize: false,
      live: false,
      ttsVoice: null,
      liveVoice: null,
    });
  });

  it("refuses to create a provider, so no cloud speech service can be called", () => {
    expect(() => createVoiceProvider(resolveVoiceRuntime())).toThrow(
      VoiceUnavailableError,
    );
  });

  it("rejects a capability the provider does not have", () => {
    const provider = {
      id: "openai" as const,
      capabilities: { transcribe: true, synthesize: false, live: false },
      transcribe: async () => ({ text: "" }),
    };
    expect(() => requireVoiceCapability(provider, "transcribe")).not.toThrow();
    expect(() => requireVoiceCapability(provider, "live")).toThrow(
      VoiceUnavailableError,
    );
    expect(() => requireVoiceCapability(provider, "synthesize")).toThrow(
      VoiceUnavailableError,
    );
  });
});
