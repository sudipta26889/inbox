import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Portainer stacks pass every key as ${KEY:-}, so a key missing from the
// stack Env reaches the app as "". env.ts must boot with that, and with the
// production values that differ from upstream's (Jev through LiteLLM).
const REPO_ROOT = join(import.meta.dirname, "..", "..");
const originalEnv = { ...process.env };

const REQUIRED = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  GOOGLE_CLIENT_ID: "id",
  GOOGLE_CLIENT_SECRET: "secret",
  GOOGLE_PUBSUB_TOPIC_NAME: "topic",
  EMAIL_ENCRYPT_SECRET: "secret",
  EMAIL_ENCRYPT_SALT: "salt",
  INTERNAL_API_KEY: "key",
  NEXT_PUBLIC_BASE_URL: "https://inbox.example.com",
  DEFAULT_LLM_PROVIDER: "litellm",
  DEFAULT_LLM_MODEL: "nemotron-3-nano-cloud",
  LLM_API_KEY: "key",
};

describe.each([
  "deploy/stack.yml",
  "deploy/stack.staging.yml",
])("env.ts with %s", (stackFile) => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of Object.keys(process.env)) delete process.env[key];
    for (const key of getStackKeys(stackFile)) process.env[key] = "";
    Object.assign(process.env, REQUIRED);
  });

  afterEach(() => {
    vi.resetModules();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  it("boots when every optional stack key is empty", async () => {
    const { env } = await import("./env");

    expect(env.DEFAULT_DECISION_MODEL).toBeUndefined();
    expect(env.DEFAULT_LLMS).toBe("litellm:nemotron-3-nano-cloud");
  });

  it("accepts production's Jev-through-LiteLLM decision model", async () => {
    process.env.DEFAULT_DECISION_MODEL = "litellm:typesafe/jev-latest";

    const { env } = await import("./env");

    expect(env.DEFAULT_DECISION_MODEL).toBe("litellm:typesafe/jev-latest");
  });
});

function getStackKeys(stackFile: string) {
  const content = readFileSync(join(REPO_ROOT, stackFile), "utf8");
  return [...content.matchAll(/^\s+([A-Z][A-Z0-9_]+): \$\{\1:-\}$/gm)].map(
    (match) => match[1],
  );
}
