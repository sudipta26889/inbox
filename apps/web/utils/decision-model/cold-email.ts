import type { EmailAccountWithAI } from "@/utils/llms/types";
import type { EmailForLLM } from "@/utils/types";
import { DEFAULT_COLD_EMAIL_PROMPT } from "@/utils/cold-email/prompt";
import {
  type DecisionModelConfig,
  DecisionUncertainError,
  runDecisionModel,
} from "./decision-model";
import { getDecisionEmailState } from "./email-state";

// Adapted from upstream inbox-zero `utils/decision-model/cold-email.ts`.
// Upstream marks cold at >= 0.75 and otherwise not cold. Here the middle band
// is uncertain and escalates: a false positive hides real mail.
const COLD_EMAIL_KEY = "cold_email";
export const MIN_COLD_EMAIL_PROBABILITY = 0.75;
export const MAX_NOT_COLD_EMAIL_PROBABILITY = 0.25;

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
  if (
    probability > MAX_NOT_COLD_EMAIL_PROBABILITY &&
    probability < MIN_COLD_EMAIL_PROBABILITY
  ) {
    throw new DecisionUncertainError(
      `Cold-email probability ${probability.toFixed(2)} is inside the uncertain band`,
    );
  }

  return {
    coldEmail: probability >= MIN_COLD_EMAIL_PROBABILITY,
    reason: `Decision model cold-email probability: ${probability.toFixed(2)}`,
  };
}
