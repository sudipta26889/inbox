import { NextResponse } from "next/server";
import { withEmailAccount } from "@/utils/middleware";
import { env } from "@/env";

export type OllamaModelsResponse = { models: string[] };

// Local Ollama (OLLAMA_BASE_URL) needs no auth; `?cloud=1` lists Ollama Cloud
// models with OLLAMA_CLOUD_API_KEY.
export const GET = withEmailAccount("api/ai/ollama-models", async (req) => {
  const cloud = new URL(req.url).searchParams.get("cloud") === "1";
  const base = cloud
    ? env.OLLAMA_CLOUD_BASE_URL || "https://ollama.com/api"
    : env.OLLAMA_BASE_URL;
  const cloudKey = env.OLLAMA_CLOUD_API_KEY?.trim();
  if (!base || (cloud && !cloudKey)) return NextResponse.json({ models: [] });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${base.replace(/\/$/, "")}/tags`, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(cloud ? { Authorization: `Bearer ${cloudKey}` } : {}),
      },
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
