import { NextResponse } from "next/server";
import { withEmailAccount } from "@/utils/middleware";
import { env } from "@/env";

export type OllamaModelsResponse = { models: string[] };

// ponytail: no auth to Ollama here — self-hosted at OLLAMA_BASE_URL. If you
// ever front Ollama with a token, add an OLLAMA_API_KEY env and pass it here.
export const GET = withEmailAccount("api/ai/ollama-models", async (req) => {
  const base = env.OLLAMA_BASE_URL;
  if (!base) return NextResponse.json({ models: [] });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${base.replace(/\/$/, "")}/tags`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      cache: "no-store",
    }).finally(() => clearTimeout(timer));

    if (!res.ok) {
      req.logger.warn("Ollama tags fetch non-200", { status: res.status });
      return NextResponse.json({ models: [] });
    }

    const body = (await res.json()) as {
      models?: Array<{ name?: string }>;
    };
    const names = (body.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0)
      .sort();

    return NextResponse.json({ models: names });
  } catch (error) {
    req.logger.error("Failed to list Ollama models", { error });
    return NextResponse.json({ models: [] });
  }
});
