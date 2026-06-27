import { describe, expect, it, vi } from "vitest";
import { getEmailAccount } from "@/__tests__/helpers";
import { enrichEmailIntoTask } from "@/utils/ai/taskpilot/enrich";
import { createGenerateObject } from "@/utils/llms";
import { getModel } from "@/utils/llms/model";

// pnpm test-ai ai-taskpilot-enrich

const isAiTest = process.env.RUN_AI_TESTS === "true";
const TIMEOUT = 60_000;

vi.mock("server-only", () => ({}));

const SUP_ID = "11111111-1111-1111-1111-111111111111";
const FIN_ID = "22222222-2222-2222-2222-222222222222";

const projects = [
  {
    id: SUP_ID,
    identifier: "SUP",
    name: "Acme Support",
    description: "Customer support requests",
  },
  {
    id: FIN_ID,
    identifier: "FIN",
    name: "Finance",
    description: "Invoices, AP, and finance ops",
  },
];

const labelsByProject = new Map([
  [
    SUP_ID,
    [
      { id: "lA", name: "urgent" },
      { id: "lB", name: "bug" },
    ],
  ],
  [FIN_ID, [{ id: "lC", name: "invoice" }]],
]);

function buildChatCompletionObject() {
  const emailAccount = getEmailAccount();
  const modelOptions = getModel(emailAccount.user, "chat");
  const generate = createGenerateObject({
    emailAccount,
    label: "taskpilot-enrich-aitest",
    modelOptions,
  });
  return async (args: { prompt: string; schema: unknown }) => {
    const result = await generate({
      ...modelOptions,
      system: "You are a strict JSON generator. Output JSON only.",
      prompt: args.prompt,
      schema: args.schema as never,
    });
    return { object: result.object };
  };
}

describe.runIf(isAiTest)("ai-taskpilot-enrich", () => {
  it(
    "returns a structurally valid draft for a customer-support email",
    async () => {
      const result = await enrichEmailIntoTask({
        email: {
          subject: "Help! my login is broken",
          from: "customer@example.com",
          snippet: "I cannot log in",
          bodyText:
            "I tried to log in to my account this morning and got an error. Can you help?",
          receivedAt: new Date(),
        },
        projects,
        labelsByProject,
        chatCompletionObject: buildChatCompletionObject(),
      });

      // projectId must be one of the provided UUIDs
      expect(projects.map((p) => p.id)).toContain(result.projectId);
      // title is non-empty and within bounds
      expect(result.title.length).toBeGreaterThan(0);
      expect(result.title.length).toBeLessThanOrEqual(100);
      // priority is from the allowed set
      expect(["urgent", "high", "medium", "low", "none"]).toContain(
        result.priority,
      );
      // labels (if any) are a subset of the chosen project's labels
      const allowed =
        labelsByProject.get(result.projectId)?.map((l) => l.name) ?? [];
      for (const name of result.labelNames) {
        expect(allowed).toContain(name);
      }
      // targetDate, if present, is YYYY-MM-DD
      if (result.targetDate !== undefined) {
        expect(result.targetDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    },
    TIMEOUT,
  );

  it(
    "returns a structurally valid draft for a finance email",
    async () => {
      const result = await enrichEmailIntoTask({
        email: {
          subject: "Invoice #88 — payment due July 10",
          from: "billing@vendor.com",
          snippet: "Please review the attached invoice",
          bodyText:
            "Hi, please find attached invoice #88. Payment is due on 2026-07-10.",
          receivedAt: new Date(),
        },
        projects,
        labelsByProject,
        chatCompletionObject: buildChatCompletionObject(),
      });

      expect(projects.map((p) => p.id)).toContain(result.projectId);
      expect(result.title.length).toBeGreaterThan(0);
      expect(result.title.length).toBeLessThanOrEqual(100);
      expect(["urgent", "high", "medium", "low", "none"]).toContain(
        result.priority,
      );
      const allowed =
        labelsByProject.get(result.projectId)?.map((l) => l.name) ?? [];
      for (const name of result.labelNames) {
        expect(allowed).toContain(name);
      }
    },
    TIMEOUT,
  );
});
