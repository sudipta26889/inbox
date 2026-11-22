export const DEFAULT_PROVIDER = "DEFAULT";

export const Provider = {
  OPEN_AI: "openai",
  AZURE: "azure",
  AZURE_FOUNDRY: "azure-foundry",
  VERTEX: "vertex",
  ANTHROPIC: "anthropic",
  BEDROCK: "bedrock",
  GOOGLE: "google",
  GROQ: "groq",
  CEREBRAS: "cerebras",
  OPENROUTER: "openrouter",
  AI_GATEWAY: "aigateway",
  OLLAMA: "ollama",
  OPENAI_COMPATIBLE: "openai-compatible",
  // The homelab LiteLLM gateway. User rows already store "litellm" with a
  // LiteLLM virtual key, so it stays its own provider id.
  LITELLM: "litellm",
  CODEX_CLI: "codex-cli",
  CLAUDE_CODE: "claude-code",
};

export const providerOptions: { label: string; value: string }[] = [
  { label: "Default", value: DEFAULT_PROVIDER },
  { label: "LiteLLM", value: Provider.LITELLM },
];
