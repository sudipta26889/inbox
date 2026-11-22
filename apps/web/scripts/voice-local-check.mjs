// Manual check of local speech on the LiteLLM gateway. Run it yourself:
//   LITELLM_BASE_URL=... LLM_API_KEY=... node scripts/voice-local-check.mjs
// Prints only status codes, durations and byte counts.
const base = (process.env.LITELLM_BASE_URL ?? "").replace(/\/+$/, "");
const key = process.env.LLM_API_KEY ?? "";
if (!(base && key)) {
  console.error("Set LITELLM_BASE_URL (ending in /v1) and LLM_API_KEY.");
  process.exit(1);
}
const sttModel = process.env.VOICE_STT_MODEL || "whisper-large-v3";
const ttsModel = process.env.VOICE_TTS_MODEL || "tts-kokoro";
const voice = process.env.VOICE_TTS_VOICE || "af_heart";

// One second of a 440 Hz tone, 16 kHz mono 16-bit PCM.
function syntheticWav() {
  const rate = 16_000;
  const samples = rate;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(
      Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)),
      i * 2,
    );
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function timed(name, run) {
  const started = Date.now();
  try {
    const response = await run();
    const bytes = (await response.arrayBuffer()).byteLength;
    console.log(
      `${name}: status ${response.status}, ${Date.now() - started} ms, ${bytes} bytes`,
    );
  } catch (error) {
    console.log(
      `${name}: failed after ${Date.now() - started} ms (${error?.name ?? "error"})`,
    );
  }
}

const form = new FormData();
form.set("model", sttModel);
form.set(
  "file",
  new Blob([syntheticWav()], { type: "audio/wav" }),
  "speech.wav",
);

await timed(`transcribe ${sttModel}`, () =>
  fetch(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  }),
);
await timed(`speak ${ttsModel}/${voice}`, () =>
  fetch(`${base}/audio/speech`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ttsModel,
      voice,
      input: "Local speech check.",
      response_format: "mp3",
    }),
    signal: AbortSignal.timeout(120_000),
  }),
);
