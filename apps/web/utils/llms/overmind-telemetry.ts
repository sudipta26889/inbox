import { context, type Tracer } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { env } from "@/env";

const FUNCTION_ID_ATTRIBUTE = "ai.telemetry.functionId";
const CAPABILITY_ID_ATTRIBUTE = "overmind.capability.id";

// Overmind binds a span to a capability by this UUID alone. The ids are
// assigned by `overmind sync` (see overmind.toml) and only change if the
// capability is deleted and recreated in the Overmind console.
const CAPABILITY_ID = {
  assistantChat: "e79228df-ab7b-4ce0-aac0-3cd068baaa22",
  coldEmailDetection: "de430b7d-7512-462c-901b-8a3f468b30c9",
  documentFiling: "ac800616-9e34-471b-9e21-462501cc9f36",
  emailDigestSummarization: "22b6092d-7594-4fc2-b73d-e53bc2876e19",
  emailReport: "bf02781d-1eff-4df8-968c-f1a34d64cdc5",
  emailRuleAutomation: "b1898fe8-4c2d-441c-b2c0-df045463d224",
  inboxCleanup: "ef0d3414-6ddb-4042-a4e1-975035e7538b",
  mcpAgent: "fdea33e2-3b8b-49fa-8336-ae06624d5cb6",
  meetingBriefs: "4724c9d4-ef1a-4fa4-9146-05b020d44be5",
  personaAnalysis: "5e047ab5-3bea-43d9-b8c5-b03f28bb300f",
  replyDrafting: "4f5ae617-c56c-449f-8013-e082f460fd50",
  rulesFromPrompt: "f3d5350e-9351-4e09-9bb9-3797831ed5d3",
  senderCategorization: "ffbc5026-793c-4635-927d-4e104dbe14f1",
  writingStyleAnalysis: "b938e287-d913-469e-9ad6-43bf6ed35cbf",
} as const;

// Keyed by the `label` each call site passes to the LLM wrappers. A label
// missing here still exports, and shows up in Overmind as an unbound trace.
const CAPABILITY_ID_BY_LABEL: Record<string, string> = {
  "assistant-chat": CAPABILITY_ID.assistantChat,
  "chat-compaction": CAPABILITY_ID.assistantChat,
  "chat-memory-extraction": CAPABILITY_ID.assistantChat,

  "Cold email check": CAPABILITY_ID.coldEmailDetection,

  "Document filing": CAPABILITY_ID.documentFiling,
  "Parse filing reply": CAPABILITY_ID.documentFiling,

  "Summarize email": CAPABILITY_ID.emailDigestSummarization,

  "email-report-email-behavior": CAPABILITY_ID.emailReport,
  "email-report-label-analysis": CAPABILITY_ID.emailReport,
  "email-report-user-persona": CAPABILITY_ID.emailReport,
  "email-report-actionable-recommendations": CAPABILITY_ID.emailReport,
  "email-report-executive-summary": CAPABILITY_ID.emailReport,
  "email-report-response-patterns": CAPABILITY_ID.emailReport,
  "email-report-summary-generation": CAPABILITY_ID.emailReport,

  "Choose rule": CAPABILITY_ID.emailRuleAutomation,
  "Args for rule": CAPABILITY_ID.emailRuleAutomation,
  "Detect recurring pattern": CAPABILITY_ID.emailRuleAutomation,

  Clean: CAPABILITY_ID.inboxCleanup,

  "MCP Agent": CAPABILITY_ID.mcpAgent,

  "Meeting Briefing": CAPABILITY_ID.meetingBriefs,
  "Perplexity Search": CAPABILITY_ID.meetingBriefs,
  "Web Search": CAPABILITY_ID.meetingBriefs,

  "Persona Analysis": CAPABILITY_ID.personaAnalysis,

  "Check if needs reply": CAPABILITY_ID.replyDrafting,
  "Determine thread status": CAPABILITY_ID.replyDrafting,
  "Reply context collector": CAPABILITY_ID.replyDrafting,
  "Draft reply": CAPABILITY_ID.replyDrafting,
  "Draft follow-up": CAPABILITY_ID.replyDrafting,
  Reply: CAPABILITY_ID.replyDrafting,
  "Knowledge extraction": CAPABILITY_ID.replyDrafting,
  "Email history extraction": CAPABILITY_ID.replyDrafting,
  "Calendar availability analysis": CAPABILITY_ID.replyDrafting,
  "Draft attachment selection": CAPABILITY_ID.replyDrafting,

  "Prompt to rules": CAPABILITY_ID.rulesFromPrompt,
  "Prompt to rules (Ollama)": CAPABILITY_ID.rulesFromPrompt,
  "Diff rules": CAPABILITY_ID.rulesFromPrompt,
  "Find existing rules": CAPABILITY_ID.rulesFromPrompt,
  "Generate rules prompt": CAPABILITY_ID.rulesFromPrompt,
  "ai-find-snippets": CAPABILITY_ID.rulesFromPrompt,

  "Categorize sender": CAPABILITY_ID.senderCategorization,
  "Categorize senders bulk": CAPABILITY_ID.senderCategorization,

  "Writing Style Analysis": CAPABILITY_ID.writingStyleAnalysis,
};

let tracer: Tracer | undefined | null = null;

export function getTelemetryOptions(label: string) {
  // Lazy so `next build`, which evaluates route modules, never starts an exporter.
  if (tracer === null) tracer = createOvermindTracer();
  return { isEnabled: true, functionId: label, tracer };
}

export function getCapabilityIdForLabel(label: string) {
  return CAPABILITY_ID_BY_LABEL[label];
}

// Every AI SDK span (root, doGenerate, tool calls) carries the functionId,
// so stamping per span binds the whole trace without walking parents.
class CapabilityStampProcessor implements SpanProcessor {
  onStart(span: Span) {
    const label = span.attributes[FUNCTION_ID_ATTRIBUTE];
    const capabilityId =
      typeof label === "string" ? getCapabilityIdForLabel(label) : undefined;
    if (capabilityId) span.setAttribute(CAPABILITY_ID_ATTRIBUTE, capabilityId);
  }
  onEnd() {}
  forceFlush() {
    return Promise.resolve();
  }
  shutdown() {
    return Promise.resolve();
  }
}

function createOvermindTracer(): Tracer | undefined {
  if (!env.OVERMIND_API_URL || !env.OVERMIND_API_KEY) return;

  // The AI SDK nests its spans through the active context. Registration is a
  // no-op if another library (e.g. Sentry) already installed a manager.
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );

  // Kept off the global provider so AI spans go to Overmind without
  // touching whatever Sentry registers globally.
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": "inbox-web" }),
    spanProcessors: [
      new CapabilityStampProcessor(),
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: `${env.OVERMIND_API_URL.replace(/\/$/, "")}/api/v1/traces`,
          headers: { "X-Api-Key": env.OVERMIND_API_KEY },
        }),
      ),
    ],
  });

  return provider.getTracer("inbox-ai");
}
