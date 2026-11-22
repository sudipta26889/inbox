import { beforeEach, describe, expect, it, vi } from "vitest";
import { LiteLLMVoiceProvider } from "./litellm";

const fetchMock = vi.fn();
const BASE = "http://litellm.test:4000/v1";

describe("LiteLLMVoiceProvider", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("transcribes on the gateway with whisper-large-v3 and the gateway key", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ text: " hello " }), { status: 200 }),
    );
    const provider = new LiteLLMVoiceProvider({
      baseUrl: `${BASE}/`,
      apiKey: "gw-key",
    });

    await expect(
      provider.transcribe({
        audio: new Uint8Array([1, 2]),
        mimeType: "audio/webm",
      }),
    ).resolves.toEqual({ text: "hello" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/audio/transcriptions`);
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer gw-key",
    );
    expect((init.body as FormData).get("model")).toBe("whisper-large-v3");
  });

  it("takes the speech-to-text model from configuration", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ text: "x" }), { status: 200 }),
    );
    const provider = new LiteLLMVoiceProvider({
      baseUrl: BASE,
      apiKey: "k",
      sttModel: "whisper-small",
    });
    await provider.transcribe({
      audio: new Uint8Array([1]),
      mimeType: "audio/webm",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.body as FormData).get("model")).toBe("whisper-small");
  });

  it("speaks with tts-kokoro as mp3 and returns the bytes", async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([9, 8, 7])));
    const provider = new LiteLLMVoiceProvider({ baseUrl: BASE, apiKey: "k" });

    const clip = await provider.synthesize({
      text: "Hello",
      voiceId: "af_heart",
    });

    expect(clip).toEqual({
      bytes: new Uint8Array([9, 8, 7]),
      mimeType: "audio/mpeg",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/audio/speech`);
    expect(JSON.parse(String(init.body))).toEqual({
      model: "tts-kokoro",
      voice: "af_heart",
      input: "Hello",
      response_format: "mp3",
    });
  });

  it("gives a cold text-to-speech start more than 60 seconds", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1])));
    const provider = new LiteLLMVoiceProvider({ baseUrl: BASE, apiKey: "k" });

    await provider.synthesize({ text: "Hi", voiceId: "af_heart" });

    expect(timeout.mock.calls[0][0]).toBeGreaterThanOrEqual(120_000);
    timeout.mockRestore();
  });

  it("reports a gateway error with its status", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "model down" } }), {
        status: 503,
      }),
    );
    const provider = new LiteLLMVoiceProvider({ baseUrl: BASE, apiKey: "k" });
    await expect(
      provider.synthesize({ text: "Hi", voiceId: "af_heart" }),
    ).rejects.toMatchObject({ status: 503, message: "model down" });
  });

  it("has no live calls of its own, and passes them on only when given a live provider", async () => {
    const without = new LiteLLMVoiceProvider({ baseUrl: BASE, apiKey: "k" });
    expect(without.capabilities).toEqual({
      transcribe: true,
      synthesize: true,
      live: false,
    });

    const createLiveSession = vi
      .fn()
      .mockResolvedValue({ sessionId: "s", sdp: "v=0" });
    const withLive = new LiteLLMVoiceProvider({
      baseUrl: BASE,
      apiKey: "k",
      live: { createLiveSession },
    });
    expect(withLive.capabilities.live).toBe(true);
    await withLive.createLiveSession({ sdp: "offer", instructions: "x" });
    expect(createLiveSession).toHaveBeenCalledWith({
      sdp: "offer",
      instructions: "x",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
