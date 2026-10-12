import { SystemType } from "@/generated/prisma/enums";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import {
  CONVERSATION_TRACKING_META_RULE_ID,
  isConversationStatusType,
} from "@/utils/reply-tracker/conversation-status-config";
import { getRuleConfig } from "@/utils/rule/consts";
import type { EmailForLLM } from "@/utils/types";
import {
  type DecisionModelConfig,
  DecisionUncertainError,
  getDecisionMinConfidence,
  runDecisionModel,
} from "./decision-model";
import { getDecisionEmailState } from "./email-state";

// Adapted from upstream inbox-zero `utils/decision-model/choose-rule.ts`. The
// fork decides cold email before rule choice (cold-email.ts), so the cold
// question is dropped, and it has no classification-feedback system, so the
// owner's corrections are not part of the state.
const NONE_KEY = "None";
const NONE_DEFINITION = "None of the rules apply to this email";
// Rule names become criteria keys, so the choice lives under a key no rule
// name can take.
const CHOICE_QUESTION_KEY = "__rule_choice__";
const EMAIL_CONTENT_MAX_LENGTH = 2000;
const DEAD_HEAT_MARGIN = 0.1;

// The rule's own text leaves digests, and automated mail carrying someone's
// words, to the Conversations rule.
const NOTIFICATION_CRITERION =
  "Notifications: Alerts, status updates, or system messages sent automatically by a platform or service, including ones that pass along something another person wrote.";

type RuleCandidate = {
  id: string;
  name: string;
  instructions: string | null;
  systemType?: string | null;
};

export async function decideRule<T extends RuleCandidate>({
  config,
  email,
  emailAccount,
  rules,
}: {
  config: DecisionModelConfig;
  email: EmailForLLM;
  emailAccount: EmailAccountWithAI;
  rules: T[];
}): Promise<{ rules: { rule: T; isPrimary?: boolean }[]; reason: string }> {
  const { criteria, rulesByKey } = buildCriteria(rules);

  const response = await runDecisionModel({
    config,
    emailAccount,
    state: {
      accountOwner: {
        email: emailAccount.email,
        about: emailAccount.about || null,
      },
      // Only the latest message: which rule fits is a property of this email.
      email: getDecisionEmailState(email, EMAIL_CONTENT_MAX_LENGTH),
      candidateRules: [...rulesByKey].map(([name, rule]) => ({
        name,
        instructions: getRuleCriterion(rule),
      })),
    },
    questions: {
      [CHOICE_QUESTION_KEY]: {
        type: "choice",
        instructions:
          "Which rule best describes this email, from the point of view of the account owner?",
        criteria,
      },
    },
    label: "Choose rule",
  });

  const answer = response.answers[CHOICE_QUESTION_KEY];
  if (answer?.type !== "choice") {
    throw new Error("Decision model response is missing the rule choice");
  }

  const { choice, probability, margin } = resolveChoice({ answer, rulesByKey });
  const minConfidence = getDecisionMinConfidence();
  if (probability < minConfidence) {
    throw new DecisionUncertainError(
      `Rule choice confidence ${probability.toFixed(2)} is below ${minConfidence}`,
    );
  }
  if (margin !== null && margin < DEAD_HEAT_MARGIN) {
    throw new DecisionUncertainError(
      `Rule choice was too close to call (margin ${margin.toFixed(2)})`,
    );
  }

  const reason = `Decision model chose "${choice}" (confidence ${probability.toFixed(2)})`;
  if (choice === NONE_KEY) return { rules: [], reason };

  const rule = rulesByKey.get(choice);
  if (!rule)
    throw new Error("Decision model chose a rule that was not offered");
  return { rules: [{ rule, isPrimary: true }], reason };
}

/**
 * "This is bulk mail" is split across every content rule while "this is a
 * conversation" collects all of its own, so the highest single answer can lose
 * a contest it wins on the total. Only those two answers are decided this way:
 * a custom rule or "None" at the top won a different contest.
 */
function resolveChoice<T extends RuleCandidate>({
  answer,
  rulesByKey,
}: {
  answer: {
    choice: string;
    confidence: number;
    probabilities: Record<string, number>;
  };
  rulesByKey: Map<string, T>;
}): { choice: string; probability: number; margin: number | null } {
  const probabilityOf = (key: string) => answer.probabilities[key] ?? 0;
  const unaggregated = {
    choice: answer.choice,
    probability: answer.confidence,
    margin: null,
  };

  const conversationKey = [...rulesByKey].find(([, rule]) =>
    isConversationRule(rule),
  )?.[0];
  const contentKeys = [...rulesByKey]
    .filter(([, rule]) => isContentRule(rule))
    .map(([key]) => key)
    .sort((a, b) => probabilityOf(b) - probabilityOf(a));

  if (!conversationKey || !contentKeys.length) return unaggregated;
  if (answer.choice !== conversationKey && !contentKeys.includes(answer.choice))
    return unaggregated;

  const conversation = probabilityOf(conversationKey);
  const content = contentKeys.reduce(
    (total, key) => total + probabilityOf(key),
    0,
  );
  const topContentKey = contentKeys[0]!;
  const choice = conversation > content ? conversationKey : topContentKey;

  const runnerUpKey = contentKeys[1];
  const contentMargin = runnerUpKey
    ? probabilityOf(topContentKey) - probabilityOf(runnerUpKey)
    : Number.POSITIVE_INFINITY;

  return {
    choice,
    probability: probabilityOf(choice),
    margin: Math.min(
      Math.abs(conversation - content),
      choice === conversationKey ? Number.POSITIVE_INFINITY : contentMargin,
    ),
  };
}

function isConversationRule(rule: RuleCandidate) {
  return (
    rule.id === CONVERSATION_TRACKING_META_RULE_ID ||
    isConversationStatusType(rule.systemType as SystemType | null)
  );
}

/** A system rule for a kind of mail: Newsletter, Receipt, Notification, ... */
function isContentRule(rule: RuleCandidate) {
  return (
    !!rule.systemType &&
    !isConversationRule(rule) &&
    rule.systemType !== SystemType.COLD_EMAIL
  );
}

function buildCriteria<T extends RuleCandidate>(rules: T[]) {
  const criteria: Record<string, string> = {};
  const rulesByKey = new Map<string, T>();
  const usedKeys = new Set<string>([
    NONE_KEY.toLowerCase(),
    CHOICE_QUESTION_KEY,
  ]);

  for (const rule of rules) {
    let key = rule.name;
    for (let n = 2; usedKeys.has(key.toLowerCase()); n++) {
      key = `${rule.name} (${n})`;
    }
    usedKeys.add(key.toLowerCase());
    criteria[key] = getRuleCriterion(rule);
    rulesByKey.set(key, rule);
  }

  criteria[NONE_KEY] = NONE_DEFINITION;
  return { criteria, rulesByKey };
}

function getRuleCriterion(rule: RuleCandidate) {
  if (
    rule.systemType === SystemType.NOTIFICATION &&
    rule.instructions === getRuleConfig(SystemType.NOTIFICATION).instructions
  ) {
    return NOTIFICATION_CRITERION;
  }
  return rule.instructions?.trim() || rule.name;
}
