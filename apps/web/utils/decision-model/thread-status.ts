import { SystemType } from "@/generated/prisma/enums";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import type { ConversationStatus } from "@/utils/reply-tracker/conversation-status-config";
import { getRuleConfig } from "@/utils/rule/consts";
import type { EmailForLLM, RuleWithActions } from "@/utils/types";
import {
  type DecisionModelConfig,
  DecisionUncertainError,
  runDecisionModel,
} from "./decision-model";
import { getDecisionEmailState } from "./email-state";

// Adapted from upstream inbox-zero `utils/decision-model/thread-status.ts`.
// Upstream takes its criteria from rule definitions this fork doesn't have
// (#3787); these are the fork's own criteria from aiDetermineThreadStatus.
const STATUS_QUESTION_KEY = "thread_status";
const MAX_MESSAGE_CONTENT_LENGTH = 4000;
export const MIN_STATUS_CONFIDENCE = 0.6;

const STATUS_CRITERIA: Record<ConversationStatus, string> = {
  [SystemType.TO_REPLY]:
    "The account owner must respond: someone asked them a direct question, requested information or action, or followed up awaiting their response; or the account owner promised to reply or deliver something and has not yet. Applies to any unanswered question or request anywhere in the thread.",
  [SystemType.AWAITING_REPLY]:
    "The account owner is waiting on someone else: they asked a question or requested something that has not been delivered yet, or another participant promised to do something and has not. It is the other side's turn.",
  [SystemType.FYI]:
    "Information the account owner received and should know about, with no question, request or pending action anywhere in the thread — updates, announcements, or requested information that leaves only optional action.",
  [SystemType.ACTIONED]:
    "Complete: every question answered, every request fulfilled, the conversation concluded with nothing pending; or the account owner sent informational content without expecting a reply.",
};

export async function decideThreadStatus({
  config,
  emailAccount,
  threadMessages,
  userSentLastEmail,
  conversationRules,
}: {
  config: DecisionModelConfig;
  emailAccount: EmailAccountWithAI;
  threadMessages: EmailForLLM[];
  userSentLastEmail: boolean;
  conversationRules: RuleWithActions[];
}): Promise<{ status: ConversationStatus; rationale: string }> {
  // FYI is only possible for mail the account owner received.
  const statuses: ConversationStatus[] = userSentLastEmail
    ? [SystemType.TO_REPLY, SystemType.AWAITING_REPLY, SystemType.ACTIONED]
    : [
        SystemType.TO_REPLY,
        SystemType.AWAITING_REPLY,
        SystemType.FYI,
        SystemType.ACTIONED,
      ];

  const response = await runDecisionModel({
    config,
    emailAccount,
    state: {
      accountOwner: {
        email: emailAccount.email,
        about: emailAccount.about || null,
      },
      userSentLastEmail,
      threadMessages: threadMessages.map((message) =>
        getDecisionEmailState(message, MAX_MESSAGE_CONTENT_LENGTH),
      ),
    },
    questions: {
      [STATUS_QUESTION_KEY]: {
        type: "choice",
        instructions: {
          question:
            "Which status applies to `threadMessages` from the perspective of `accountOwner`?",
          chronology:
            "Read every message from oldest to newest. Unanswered questions and promised deliverables stay pending until fulfilled; a newer informational message does not erase an older unresolved request.",
          perspective:
            "Distinguish work owed by the account owner from work owed by another participant. Ignore exchanges solely between other participants.",
          commitments:
            "If another participant promised something, the owner is awaiting it. If the owner promised something, the owner must reply. A clarifying question that got answered does not cancel the owner's pending commitment.",
        },
        criteria: Object.fromEntries(
          statuses.map((status) => [
            status,
            withUserPreference(status, conversationRules),
          ]),
        ),
      },
    },
    label: "Determine thread status",
  });

  const answer = response.answers[STATUS_QUESTION_KEY];
  if (answer?.type !== "choice") {
    throw new Error("Decision model response is missing the thread status");
  }
  if (!statuses.includes(answer.choice as ConversationStatus)) {
    throw new Error("Decision model returned an unknown thread status");
  }
  if (answer.confidence < MIN_STATUS_CONFIDENCE) {
    throw new DecisionUncertainError(
      `Thread status confidence ${answer.confidence.toFixed(2)} is below ${MIN_STATUS_CONFIDENCE}`,
    );
  }

  return {
    status: answer.choice as ConversationStatus,
    rationale: `Decision model chose ${answer.choice} with ${Math.round(answer.confidence * 100)}% confidence.`,
  };
}

// A user's edited status instructions take priority, as in the LLM prompt.
function withUserPreference(
  status: ConversationStatus,
  conversationRules: RuleWithActions[],
) {
  const rule = conversationRules.find(
    (r) => r.enabled && r.systemType === status && r.instructions,
  );
  const customized =
    rule?.instructions &&
    rule.instructions !== getRuleConfig(status).instructions;

  return customized
    ? `${STATUS_CRITERIA[status]} The account owner's own definition, which takes priority: ${rule.instructions}`
    : STATUS_CRITERIA[status];
}
