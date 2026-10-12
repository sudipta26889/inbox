import type { EmailAccountWithAI } from "@/utils/llms/types";
import type { EmailForLLM } from "@/utils/types";
import { DEFAULT_COLD_EMAIL_PROMPT } from "@/utils/cold-email/prompt";
import {
  type DecisionModelConfig,
  DecisionUncertainError,
  getDecisionMinConfidence,
  runDecisionModel,
} from "./decision-model";
import { getDecisionEmailState } from "./email-state";

// Adapted from upstream inbox-zero `utils/decision-model/cold-email.ts`.
// Upstream marks cold at >= 0.75 and otherwise not cold. Here only a confident
// answer either way decides; the middle band escalates, since a false positive
// hides real mail.
const COLD_EMAIL_KEY = "cold_email";

export async function decideColdEmail({
  config,
  email,
  emailAccount,
  coldEmailPrompt,
}: {
  config: DecisionModelConfig;
  email: EmailForLLM;
  emailAccount: EmailAccountWithAI;
  coldEmailPrompt?: string | null;
}): Promise<{ coldEmail: boolean; reason: string }> {
  const response = await runDecisionModel({
    config,
    emailAccount,
    state: {
      accountOwner: {
        email: emailAccount.email,
        about: emailAccount.about || null,
      },
      email: getDecisionEmailState(email, 2000),
      coldEmailDefinition: coldEmailPrompt?.trim() || DEFAULT_COLD_EMAIL_PROMPT,
    },
    questions: {
      [COLD_EMAIL_KEY]: {
        type: "boolean",
        instructions:
          "Is `email` cold outreach under `coldEmailDefinition` from the perspective of `accountOwner`?",
        criteria: {
          true: "The message is unsolicited outreach that meets the supplied cold-email definition.",
          false:
            "The message is ordinary marketing, a newsletter, an account message, receipt, alert, calendar invite, or a valuable specific opportunity.",
        },
      },
    },
    label: "Cold email check",
  });

  const answer = response.answers[COLD_EMAIL_KEY];
  if (answer?.type !== "boolean") {
    throw new Error("Decision model response is missing the cold-email answer");
  }

  const probability = answer.probability;
  const minConfidence = getDecisionMinConfidence();
  if (probability > 1 - minConfidence && probability < minConfidence) {
    throw new DecisionUncertainError(
      `Cold-email probability ${probability.toFixed(2)} is inside the uncertain band`,
    );
  }

  return {
    coldEmail: probability >= minConfidence,
    reason: `Decision model cold-email probability: ${probability.toFixed(2)}`,
  };
}
