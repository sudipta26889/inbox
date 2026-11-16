import { jsonrepair } from "jsonrepair";
import { z } from "zod";
import { createScopedLogger } from "@/utils/logger";
import { createGenerateObject } from "@/utils/llms/index";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import type { EmailForLLM } from "@/utils/types";
import { getEmailListPrompt, getTodayForLLM } from "@/utils/ai/helpers";
import { getModel } from "@/utils/llms/model";
import type { ReplyContextCollectorResult } from "@/utils/ai/reply/reply-context-collector";
import type { CalendarAvailabilityContext } from "@/utils/ai/calendar/availability";
import { PROMPT_SECURITY_INSTRUCTIONS } from "@/utils/ai/security";
import { DraftReplyConfidence } from "@/generated/prisma/enums";
import { normalizeDraftReplyConfidence } from "@/utils/ai/reply/draft-confidence";
import {
  createDraftAttributionTracker,
  type DraftAttribution,
} from "@/utils/ai/reply/draft-attribution";

const logger = createScopedLogger("DraftReply");
const DRAFT_OUTPUT_INSTRUCTION =
  "The reply field is plain text only. Do not use HTML tags. If a clickable link is necessary, use markdown links in the format [Label](https://example.com/path) or [Label](mailto:name@example.com).";

const systemPrompt = `You write email replies as the user, in their voice, using knowledge base information. The user reviews and edits every draft before it is sent.

${PROMPT_SECURITY_INSTRUCTIONS}

Use context from the previous emails and the provided knowledge base to make it relevant and accurate.
IMPORTANT: Do NOT simply repeat or mirror what the last email said. It doesn't add anything to the conversation to repeat back to them what they just said.
Don't mention that you're an AI.
Don't reply with a Subject. Only reply with the body of the email.
${DRAFT_OUTPUT_INSTRUCTION}
IMPORTANT: Format paragraphs using Unix newlines: use "\n\n" between paragraphs and "\n" for single line breaks.
Write the reply in the same language as the latest message in the thread.

Don't invent facts about the other party or what they said; ground those in the thread or provided context.
Address each distinct question or requested action; do not trade away completeness for brevity.
When the sender asks several separate questions, answer each one on its own, in their order, so they can match every answer to its question. If they numbered or bulleted them, reply with the same numbering or bullets. Keep each answer brief.
Only state facts, numbers, dates, prices, reasons, statuses and commitments that appear in the thread, the knowledge base, the email history, the calendar information or other provided context. Never invent them, and never claim the user did something (read, reviewed, sent, paid, decided) unless the context shows it.
When an answer needs the user's own decision or information that is not in the context, write a short placeholder in square brackets for the user to fill in, e.g. [your answer: the 3rd or the 10th?] or [confirm: does 4 pm IST work?]. Never fill it with a guess. Keep the rest of the reply complete around it.
Address each distinct question; a placeholder counts as addressing it.
End the reply without a sign-off or the user's name; their signature is added automatically.
Never use a placeholder for the user's name. Do not add a signature or sign-off.
Do not use em dashes unless the provided writing style explicitly calls for them.
Don't suggest meeting times or mention availability unless specific calendar information is provided.

Write an email that follows up on the previous conversation.
Your reply should aim to continue the conversation or provide new information based on the context or knowledge base. If you have nothing substantial to add, keep the reply minimal.

Example when the context does not contain the answer:
Sender: "Can you confirm the workshop fee is $500 and we're booked for Friday?" (the context has no fee or booking)
Good: "Thanks. [confirm: is the fee $500?] [confirm: are we booked for Friday?]"
Bad: "Yes, $500 and Friday are both right."
`;

const defaultWritingStyle = `Keep it concise and friendly.
Keep the reply short. Aim for 2 sentences at most.
Don't be pushy.
Write in a polite and professional tone.`;

const getUserPrompt = ({
  messages,
  emailAccount,
  knowledgeBaseContent,
  emailHistorySummary,
  emailHistoryContext,
  calendarAvailability,
  writingStyle,
  mcpContext,
  meetingContext,
  attachmentContext,
}: {
  messages: (EmailForLLM & { to: string })[];
  emailAccount: EmailAccountWithAI;
  knowledgeBaseContent: string | null;
  emailHistorySummary: string | null;
  emailHistoryContext: ReplyContextCollectorResult | null;
  calendarAvailability: CalendarAvailabilityContext | null;
  writingStyle: string | null;
  mcpContext: string | null;
  meetingContext: string | null;
  attachmentContext: string | null;
}) => {
  const userAbout = emailAccount.about
    ? `Context about the user:

<userAbout>
${emailAccount.about}
</userAbout>
`
    : "";

  const relevantKnowledge = knowledgeBaseContent
    ? `Relevant knowledge base content:

<knowledge_base>
${knowledgeBaseContent}
</knowledge_base>
`
    : "";

  const historicalContext = emailHistorySummary
    ? `Historical email context with this sender:

<sender_history>
${emailHistorySummary}
</sender_history>
`
    : "";

  const precedentHistoryContext = emailHistoryContext?.relevantEmails.length
    ? `Information from similar email threads that may be relevant to the current conversation to draft a reply.

<email_history>
${emailHistoryContext.relevantEmails
  .map(
    (item) => `<item>
${item}
</item>`,
  )
  .join("\n")}
</email_history>

<email_history_notes>
${emailHistoryContext.notes || "No notes"}
</email_history_notes>
`
    : "";

  const writingStylePrompt = writingStyle
    ? `Writing style:

<writing_style>
${writingStyle}
</writing_style>
`
    : "";

  const schedulingContext = getSchedulingContext({
    calendarBookingLink: emailAccount.calendarBookingLink,
    calendarAvailability,
  });

  const mcpToolsContext = mcpContext
    ? `Additional context fetched from external tools (such as CRM systems, task managers, or other integrations) that may help draft a response:

<external_tools_context>
${mcpContext}
</external_tools_context>
`
    : "";

  const upcomingMeetingsContext = meetingContext || "";
  const selectedAttachments = attachmentContext
    ? `Selected PDF attachments that will be included with this draft:

<selected_attachments>
${attachmentContext}
</selected_attachments>

Mention attached documents only when useful and only if this section is present.
`
    : "";

  return `${userAbout}
${relevantKnowledge}
${historicalContext}
${precedentHistoryContext}
${writingStylePrompt}
${schedulingContext}
${mcpToolsContext}
${upcomingMeetingsContext}
${selectedAttachments}

Here is the context of the email thread (from oldest to newest):
${getEmailListPrompt({ messages, messageMaxLength: 3000 })}

Please write a reply to the email.
${getTodayForLLM()}
IMPORTANT: You are writing an email as ${emailAccount.email}. Write the reply from their perspective.`;
};

const draftSchema = z.object({
  reply: z
    .string()
    .describe(
      "The complete email reply draft incorporating knowledge base information",
    ),
  confidence: z
    .nativeEnum(DraftReplyConfidence)
    .describe(
      "Required value: ALL_EMAILS, STANDARD, or HIGH_CONFIDENCE. Use ALL_EMAILS when uncertain or context is missing, STANDARD for solid drafts with minor uncertainty, and HIGH_CONFIDENCE only when intent and response are clear.",
    ),
});

export type DraftReplyResult = {
  reply: string;
  confidence: DraftReplyConfidence;
  attribution: DraftAttribution | null;
};

export async function aiDraftReplyWithConfidence({
  messages,
  emailAccount,
  knowledgeBaseContent,
  emailHistorySummary,
  emailHistoryContext,
  calendarAvailability,
  writingStyle,
  mcpContext,
  meetingContext,
  attachmentContext = null,
}: {
  messages: (EmailForLLM & { to: string })[];
  emailAccount: EmailAccountWithAI;
  knowledgeBaseContent: string | null;
  emailHistorySummary: string | null;
  emailHistoryContext: ReplyContextCollectorResult | null;
  calendarAvailability: CalendarAvailabilityContext | null;
  writingStyle: string | null;
  mcpContext: string | null;
  meetingContext: string | null;
  attachmentContext?: string | null;
}): Promise<DraftReplyResult> {
  logger.info("Drafting email reply", {
    messageCount: messages.length,
    hasKnowledge: !!knowledgeBaseContent,
    hasHistory: !!emailHistorySummary,
    calendarAvailability: calendarAvailability
      ? {
          noAvailability: calendarAvailability.noAvailability,
          suggestedTimesCount: calendarAvailability.suggestedTimes?.length || 0,
        }
      : null,
  });

  const prompt = getUserPrompt({
    messages,
    emailAccount,
    knowledgeBaseContent,
    emailHistorySummary,
    emailHistoryContext,
    calendarAvailability,
    writingStyle: writingStyle || defaultWritingStyle,
    mcpContext,
    meetingContext,
    attachmentContext,
  });

  const modelOptions = getModel(emailAccount.user, "draft");
  const attributionTracker = createDraftAttributionTracker();

  const generateObject = createGenerateObject({
    emailAccount,
    label: "Draft reply",
    modelOptions,
    onModelUsed: attributionTracker.onModelUsed,
  });

  const generate = () =>
    generateObject({
      ...modelOptions,
      system: systemPrompt,
      prompt,
      schema: draftSchema,
      // Overrides the generic repair, which would turn bare email text into a
      // JSON array that can never match draftSchema.
      experimental_repairText: async ({ text }) => repairDraftReplyText(text),
    });

  let result = await generate();

  if (REPETITIVE_TEXT_PATTERN.test(result.object.reply)) {
    logger.warn("Draft reply rejected: repetitive output detected, retrying");
    result = await generate();

    if (REPETITIVE_TEXT_PATTERN.test(result.object.reply)) {
      logger.warn("Draft reply rejected: repetitive output on retry");
      throw new Error("Draft reply generation produced invalid output");
    }
  }

  return {
    reply: normalizeDraftReplyFormatting(result.object.reply),
    // A placeholder means the user still has to decide something, so it is
    // never more than the lowest confidence whatever the model claims.
    confidence: hasDraftPlaceholder(result.object.reply)
      ? DraftReplyConfidence.ALL_EMAILS
      : normalizeDraftReplyConfidence(result.object.confidence),
    attribution: attributionTracker.attribution,
  };
}

export async function aiDraftReply({
  messages,
  emailAccount,
  knowledgeBaseContent,
  emailHistorySummary,
  emailHistoryContext,
  calendarAvailability,
  writingStyle,
  mcpContext,
  meetingContext,
  attachmentContext = null,
}: {
  messages: (EmailForLLM & { to: string })[];
  emailAccount: EmailAccountWithAI;
  knowledgeBaseContent: string | null;
  emailHistorySummary: string | null;
  emailHistoryContext: ReplyContextCollectorResult | null;
  calendarAvailability: CalendarAvailabilityContext | null;
  writingStyle: string | null;
  mcpContext: string | null;
  meetingContext: string | null;
  attachmentContext?: string | null;
}) {
  const result = await aiDraftReplyWithConfidence({
    messages,
    emailAccount,
    knowledgeBaseContent,
    emailHistorySummary,
    emailHistoryContext,
    calendarAvailability,
    writingStyle,
    mcpContext,
    meetingContext,
    attachmentContext,
  });

  return result.reply;
}

function normalizeDraftReplyFormatting(reply: string): string {
  const withNormalizedLineEndings = reply.replace(/\r\n?|\u2028|\u2029/g, "\n");

  const withDecodedEscapedNewlines = /\\r\\n|\\n|\\r/.test(
    withNormalizedLineEndings,
  )
    ? withNormalizedLineEndings
        .replace(/\\r\\n/g, "\n")
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\n")
    : withNormalizedLineEndings;

  const cleaned = withDecodedEscapedNewlines
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const nonEmptyLines = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (shouldConvertSingleLineBreaksToParagraphs(nonEmptyLines)) {
    return nonEmptyLines.join("\n\n");
  }

  return cleaned;
}

function shouldConvertSingleLineBreaksToParagraphs(lines: string[]): boolean {
  if (lines.length < 2) return false;

  if (lines.some((line) => isLikelyListItem(line))) return false;

  const punctuatedLines = lines.filter((line) => /[.!?]$/.test(line)).length;
  const punctuationRatio = punctuatedLines / lines.length;

  return punctuationRatio >= 0.6;
}

function isLikelyListItem(line: string): boolean {
  return /^(\s*[-*]\s+|\s*\d+[.)]\s+|\s*[a-zA-Z][.)]\s+|>\s+)/.test(line);
}

// Matches any non-separator, non-whitespace character repeated 50+ times in a row
const REPETITIVE_TEXT_PATTERN = /([^\s\-=_*.#~])\1{49,}/u;

function getSchedulingContext({
  calendarBookingLink,
  calendarAvailability,
}: {
  calendarBookingLink: string | null;
  calendarAvailability: CalendarAvailabilityContext | null;
}): string {
  const parts: string[] = [];

  if (calendarBookingLink) {
    parts.push(`<booking_link>
${calendarBookingLink}
</booking_link>

When the sender has requested or is open to a call/meeting, share this booking link as the primary way to schedule.`);
  }

  if (calendarAvailability?.noAvailability) {
    parts.push(`The user has no available time slots in the requested timeframe.
Do not suggest specific times. Acknowledge the request and suggest alternatives (e.g., "I'm fully booked tomorrow, but let's find another day that works"${calendarBookingLink ? " or share the booking link" : ""}).`);
  } else if (calendarAvailability?.suggestedTimes.length) {
    const times = calendarAvailability.suggestedTimes
      .map((slot) => `- ${slot.start} to ${slot.end}`)
      .join("\n");

    parts.push(`Available time slots:
${times}

${calendarBookingLink ? "Lead with the booking link, then optionally suggest a few of these times as alternatives." : "Use these time slots when responding to meeting requests."} Format suggested times as a bulleted list.`);
  }

  if (parts.length === 0) return "";

  return `Scheduling context:

<scheduling>
${parts.join("\n\n")}
</scheduling>
`;
}

export function repairDraftReplyText(text: string): string {
  if (!text.trim()) return text;

  const parsed = parseJsonObject(text);
  if (parsed && typeof parsed.reply === "string") {
    // A missing or invented confidence would fail the schema; the lowest one
    // keeps the user reviewing the draft.
    const confidence = isDraftReplyConfidence(parsed.confidence)
      ? parsed.confidence
      : DraftReplyConfidence.ALL_EMAILS;
    return JSON.stringify({ ...parsed, confidence });
  }

  // Some models ignore the schema and answer with the bare email. The lowest
  // confidence keeps the user reviewing it.
  return JSON.stringify({
    reply: text.trim(),
    confidence: DraftReplyConfidence.ALL_EMAILS,
  });
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  for (const candidate of [unfenced, tryJsonRepair(unfenced)]) {
    if (candidate === null) continue;
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function tryJsonRepair(text: string): string | null {
  try {
    return jsonrepair(text);
  } catch {
    return null;
  }
}

function isDraftReplyConfidence(value: unknown): value is DraftReplyConfidence {
  return Object.values(DraftReplyConfidence).includes(
    value as DraftReplyConfidence,
  );
}

export function hasDraftPlaceholder(reply: string): boolean {
  // The lookahead skips markdown links, `[label](url)`.
  return /\[[^[\]]{2,200}\](?!\()/.test(reply);
}
