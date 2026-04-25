import { z } from "zod";
import { createGenerateObject, createGenerateText } from "@/utils/llms";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import {
  type CreateRuleSchema,
  createRuleSchema,
} from "@/utils/ai/rule/create-rule-schema";
import { PROMPT_TO_RULES_SHARED_GUIDANCE } from "@/utils/ai/rule/prompt-to-rules-guidance";
import { createScopedLogger } from "@/utils/logger";
import { convertMentionsToLabels } from "@/utils/mention";
import { getModel } from "@/utils/llms/model";
import { jsonrepair } from "jsonrepair";

const logger = createScopedLogger("ai-prompt-to-rules");

export async function aiPromptToRules({
  emailAccount,
  promptFile,
}: {
  emailAccount: EmailAccountWithAI;
  promptFile: string;
}): Promise<CreateRuleSchema[]> {
  const modelOptions = getModel(emailAccount.user, "chat");

  // Local/proxied models (Ollama, LiteLLM) don't enforce schemas like
  // OpenAI's structured outputs. Fall back to generateText + manual parsing.
  const needsManualParsing =
    modelOptions.model?.modelId?.startsWith("ollama/") ||
    modelOptions.provider === "litellm" ||
    modelOptions.provider === "openai-compatible";

  if (needsManualParsing) {
    return await aiPromptToRulesOllama({
      emailAccount,
      promptFile,
      modelOptions,
    });
  }

  const system = getSystemPrompt(emailAccount.account.provider, false);

  const cleanedPromptFile = convertMentionsToLabels(promptFile);

  const prompt = `Convert the following prompt file into rules:

<prompt>
${cleanedPromptFile}
</prompt>`;

  const generateObject = createGenerateObject({
    emailAccount,
    label: "Prompt to rules",
    modelOptions,
  });

  const aiResponse = await generateObject({
    ...modelOptions,
    prompt,
    system,
    schema: z.object({
      rules: z.array(createRuleSchema(emailAccount.account.provider)),
    }),
  });

  if (!aiResponse.object) {
    logger.error("No rules found in AI response", { aiResponse });
    throw new Error("No rules found in AI response");
  }

  const rules = aiResponse.object.rules;

  return rules;
}

async function aiPromptToRulesOllama({
  emailAccount,
  promptFile,
  modelOptions,
}: {
  emailAccount: EmailAccountWithAI;
  promptFile: string;
  modelOptions: ReturnType<typeof getModel>;
}): Promise<CreateRuleSchema[]> {
  const system = getSystemPrompt(emailAccount.account.provider, true);
  const cleanedPromptFile = convertMentionsToLabels(promptFile);

  const prompt = `Convert the following prompt file into rules:

<prompt>
${cleanedPromptFile}
</prompt>

Return ONLY valid JSON matching the schema shown in the system prompt. No markdown, no explanations.`;

  const generateText = createGenerateText({
    emailAccount,
    label: "Prompt to rules (Ollama)",
    modelOptions,
  });

  const aiResponse = await generateText({
    ...modelOptions,
    prompt,
    system,
  });

  logger.info("Ollama raw response", {
    text: aiResponse.text.substring(0, 1000),
  });

  // Clean up the response - remove markdown code blocks if present
  let jsonText = aiResponse.text.trim();
  if (jsonText.startsWith("```json")) {
    jsonText = jsonText.replace(/^```json\n/, "").replace(/\n```$/, "");
  } else if (jsonText.startsWith("```")) {
    jsonText = jsonText.replace(/^```\n/, "").replace(/\n```$/, "");
  }

  // Repair any JSON issues
  const repairedJson = jsonrepair(jsonText);
  logger.info("Repaired JSON", { json: repairedJson.substring(0, 1000) });

  // Parse and validate
  const parsed = JSON.parse(repairedJson);
  const schema = z.object({
    rules: z.array(createRuleSchema(emailAccount.account.provider)),
  });

  const validated = schema.parse(parsed);
  return validated.rules;
}

function getSystemPrompt(provider: string, includeExample = false) {
  const basePrompt = `You are an AI assistant that converts email management rules into a structured format. Parse the given prompt and convert it into rules.

Use short, concise rule names (preferably a single word). For example: 'Marketing', 'Newsletters', 'Urgent', 'Receipts'. Avoid verbose names like 'Archive and label marketing emails'.

${PROMPT_TO_RULES_SHARED_GUIDANCE}`;

  if (!includeExample) {
    return basePrompt;
  }

  // For models without structured output support (like Ollama), include a complete example
  const exampleRule = {
    name: "Marketing",
    condition: {
      conditionalOperator: null,
      aiInstructions:
        "Apply to marketing and promotional emails from newsletters",
      static: {
        from: null,
        to: null,
        subject: null,
      },
    },
    actions: [
      {
        type: "ARCHIVE",
        fields: null,
        delayInMinutes: null,
      },
      {
        type: "LABEL",
        fields: {
          label: "Marketing",
          to: null,
          cc: null,
          bcc: null,
          subject: null,
          content: null,
          webhookUrl: null,
        },
        delayInMinutes: null,
      },
    ],
  };

  return `${basePrompt}

IMPORTANT: Your response must EXACTLY match this JSON structure:

{
  "rules": [
    ${JSON.stringify(exampleRule, null, 2)}
  ]
}

Key points:
- Each rule MUST have a "condition" object with "conditionalOperator", "aiInstructions", and "static" fields
- Each action MUST be an object with "type", "fields", and "delayInMinutes"
- Valid action types: LABEL, ARCHIVE, MARK_READ, DRAFT_EMAIL, REPLY, FORWARD, SEND_EMAIL, MARK_SPAM, DIGEST, CALL_WEBHOOK
- To delete emails, use MARK_SPAM (not DELETE)
- Set fields to null if not needed
- Use null values, not undefined or missing fields`;
}
