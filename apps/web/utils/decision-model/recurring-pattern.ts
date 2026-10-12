import type { EmailAccountWithAI } from "@/utils/llms/types";
import type { EmailForLLM } from "@/utils/types";
import {
  type DecisionModelConfig,
  type DecisionQuestion,
  runDecisionModel,
} from "./decision-model";
import { getDecisionEmailState } from "./email-state";

// Backport of upstream inbox-zero `utils/decision-model/recurring-pattern.ts`.
// "No match" is the safe answer (no sender pattern is learned), so a weak
// match returns null instead of escalating — matching the LLM's own 90% bar.
const RULE_KEY_PREFIX = "rule_";
export const MIN_PATTERN_PROBABILITY = 0.9;
const MAX_PATTERN_SAMPLE_EMAILS = 10;

export async function decideRecurringPattern({
  config,
  emails,
  emailAccount,
  rules,
  consistentRuleName,
}: {
  config: DecisionModelConfig;
  emails: EmailForLLM[];
  emailAccount: EmailAccountWithAI;
  rules: { name: string; instructions: string }[];
  consistentRuleName?: string;
}): Promise<{ matchedRule: string | null; explanation: string }> {
  const candidateRules = consistentRuleName
    ? rules.filter((rule) => rule.name === consistentRuleName)
    : rules;
  if (candidateRules.length === 0) {
    return {
      matchedRule: null,
      explanation: "No eligible rule was available for pattern matching.",
    };
  }

  const questions: Record<string, DecisionQuestion> = Object.fromEntries(
    candidateRules.map((_rule, index) => [
      `${RULE_KEY_PREFIX}${index}`,
      {
        type: "boolean",
        // Phrased as a judgement on the samples, not a forecast: a forecast
        // made Jev hedge (0.75-0.88) on obvious senders such as calendar
        // invites and order receipts that the LLM matched outright.
        instructions: `Are all of \`sampleEmails\` from \`sender\` the same kind of message, and is that kind exactly what \`candidateRules[${index}]\` describes?`,
        criteria: {
          true: "Every sample is the same type of message — typically automated or templated, such as order confirmations, receipts, calendar invitations, alerts or newsletters — and this rule's instructions describe that type.",
          false:
            "The samples are of different types, include personal or conversational messages, or are of a type this rule's instructions do not describe.",
        },
      },
    ]),
  );

  const response = await runDecisionModel({
    config,
    emailAccount,
    state: {
      sender: emails[0]?.from,
      accountOwner: {
        email: emailAccount.email,
        about: emailAccount.about || null,
      },
      sampleEmails: emails
        .slice(-MAX_PATTERN_SAMPLE_EMAILS)
        .map((email) => getDecisionEmailState(email, 500)),
      candidateRules,
    },
    questions,
    label: "Detect recurring pattern",
  });

  const bestMatch = candidateRules
    .map((rule, index) => {
      const answer = response.answers[`${RULE_KEY_PREFIX}${index}`];
      return {
        rule,
        probability: answer?.type === "boolean" ? answer.probability : 0,
      };
    })
    .sort((a, b) => b.probability - a.probability)[0];

  if (!bestMatch || bestMatch.probability < MIN_PATTERN_PROBABILITY) {
    return {
      matchedRule: null,
      explanation: bestMatch
        ? `The strongest rule had ${Math.round(bestMatch.probability * 100)}% confidence, below the recurring-pattern threshold.`
        : "No rule cleared the recurring-pattern confidence threshold.",
    };
  }

  return {
    matchedRule: bestMatch.rule.name,
    explanation: `Decision model matched this sender to ${bestMatch.rule.name} with ${Math.round(bestMatch.probability * 100)}% confidence.`,
  };
}
