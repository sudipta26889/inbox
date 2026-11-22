import type {
  SpeechClip,
  VoiceLiveSession,
  VoiceLiveSessionRequest,
  VoiceProvider,
  VoiceSynthesizeRequest,
  VoiceTranscribeRequest,
} from "@/utils/voice/types";
import {
  extractErrorMessage,
  readJsonBody,
  transcribeOpenAiCompatible,
  voiceDeadline,
} from "@/utils/voice/http";
import { VoiceRequestError } from "@/utils/voice/errors";
import {
  DEFAULT_LITELLM_STT_MODEL,
  DEFAULT_LITELLM_TTS_MODEL,
  VOICE_SYNTHESIZE_TIMEOUT_MS,
} from "@/utils/voice/limits";

/**
 * Local speech on the LiteLLM gateway, which speaks the OpenAI audio API:
 * Whisper for dictation and Kokoro for spoken replies. The gateway has no
 * realtime route, so live calls go to `live` when one is given.
 */
export class LiteLLMVoiceProvider implements VoiceProvider {
  readonly id = "litellm" as const;
  readonly capabilities: VoiceProvider["capabilities"];
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly sttModel?: string;
  private readonly ttsModel?: string;
  private readonly live?: Pick<VoiceProvider, "createLiveSession">;

  constructor(options: {
    baseUrl: string;
    apiKey: string;
    sttModel?: string;
    ttsModel?: string;
    live?: Pick<VoiceProvider, "createLiveSession">;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.sttModel = options.sttModel;
    this.ttsModel = options.ttsModel;
    this.live = options.live;
    this.capabilities = {
      transcribe: true,
      synthesize: true,
      live: Boolean(options.live),
    };
  }

  async transcribe(request: VoiceTranscribeRequest): Promise<{ text: string }> {
    return transcribeOpenAiCompatible({
      url: `${this.baseUrl}/audio/transcriptions`,
      apiKey: this.apiKey,
      model: this.sttModel || DEFAULT_LITELLM_STT_MODEL,
      audio: request.audio,
      mimeType: request.mimeType,
      signal: request.signal,
    });
  }

  async synthesize(request: VoiceSynthesizeRequest): Promise<SpeechClip> {
    // Kokoro starts on demand, so the first call can take tens of seconds.
    const response = await fetch(`${this.baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.ttsModel || DEFAULT_LITELLM_TTS_MODEL,
        voice: request.voiceId,
        input: request.text,
        response_format: "mp3",
      }),
      signal: voiceDeadline(request.signal, VOICE_SYNTHESIZE_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await readJsonBody(response);
      throw new VoiceRequestError(
        extractErrorMessage(body) ||
          `The speech gateway failed while speaking (${response.status})`,
        response.status >= 400 && response.status < 600 ? response.status : 502,
      );
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      mimeType: "audio/mpeg",
    };
  }

  createLiveSession(
    request: VoiceLiveSessionRequest,
  ): Promise<VoiceLiveSession> {
    if (!this.live?.createLiveSession) {
      throw new VoiceRequestError("Live calls are not available.", 501);
    }
    return this.live.createLiveSession(request);
  }
}
