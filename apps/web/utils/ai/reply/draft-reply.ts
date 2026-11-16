import { jsonrepair } from "jsonrepair";
import { z } from "zod";
import { TZDate } from "@date-fns/tz";
import { createScopedLogger } from "@/utils/logger";
import { createGenerateObject } from "@/utils/llms/index";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import type { EmailForLLM } from "@/utils/types";
import {
  getEmailListPrompt,
  getTodayForLLM,
  getUserAboutPrompt,
  getWritingStylePrompt,
} from "@/utils/ai/helpers";
import { getModelForUseCase, LlmUseCase } from "@/utils/llms/use-cases";
import { appendOllamaOnlySystemGuidance } from "@/utils/llms/ollama-guidance";
import type { ReplyContextCollectorResult } from "@/utils/ai/reply/reply-context-collector";
import type { CalendarAvailabilityContext } from "@/utils/ai/calendar/availability";
import { DraftReplyConfidence } from "@/generated/prisma/enums";
import { env } from "@/env";
import { normalizeDraftReplyConfidence } from "@/utils/ai/reply/draft-confidence";
import {
  createDraftAttributionTracker,
  type DraftAttribution,
} from "@/utils/ai/reply/draft-attribution";

const logger = createScopedLogger("DraftReply");
const DRAFT_OUTPUT_INSTRUCTION =
  "The reply field is plain text only. Do not use HTML tags. If a clickable link is necessary, use markdown links in the format [Label](https://example.com/path) or [Label](mailto:name@example.com).";

const systemPrompt = `You write email replies as the user, in their voice. The user reviews and edits every draft before it is sent.

Use context from the previous emails and the provided knowledge base to make it relevant and accurate.
Current thread facts override advisory context. Do not ask for details already present there.
IMPORTANT: Do NOT simply repeat or mirror what the last email said. It doesn't add anything to the conversation to repeat back to them what they just said.
Don't mention that you're an AI.
Don't reply with a Subject. Only reply with the body of the email.
${DRAFT_OUTPUT_INSTRUCTION}
IMPORTANT: Format paragraphs using Unix newlines: use "\n\n" between paragraphs and "\n" for single line breaks.
Write the reply in the same language as the latest message in the thread.

Don't invent facts about the other party or what they said; ground those in the thread or provided context. If the sender wrongly assumes something about the user, correct it only when the context shows what is true.
Don't pass the request to anyone else, including people in To or Cc, unless the context says they handle it. Don't claim the user copied someone in or did anything the thread or context doesn't show.
Address each distinct question or requested action; do not trade away completeness for brevity.
When the sender asks several separate questions, answer each one on its own, in their order, so they can match every answer to its question. If they numbered or bulleted them, reply with the same numbering or bullets. Keep each answer brief.
Only state facts, numbers, dates, prices, reasons, statuses and commitments that appear in the thread, the knowledge base, the email history, the calendar information or other provided context. Never invent them, and never claim the user did something (read, reviewed, sent, paid, decided) unless the context shows it.
Quote numbers, amounts, dates and counts exactly as they appear in the context. Never calculate, estimate, round or derive new ones (rates, totals, day counts, differences); if the reply needs such a number, use a placeholder like [your answer: the day rate?].
Never mention your own context or what you can or cannot see (for example that something did not come through, is missing, or is not in front of you). When something you would need is not in the context, use a placeholder instead.
When an answer needs the user's own decision or information that is not in the context, write a short placeholder in square brackets for the user to fill in, e.g. [your answer: the 3rd or the 10th?] or [confirm: does 4 pm IST work?]. Never fill it with a guess. Keep the rest of the reply complete around it.
Never accept, agree to, decide or promise anything on the user's behalf, including a future action such as "I'll send/reissue/check", unless the thread shows the user already said so. A free calendar slot is not agreement: write [confirm: 4 pm IST on Friday works? Your calendar is free then] instead of accepting. A pattern in past emails is not a commitment: put it in a placeholder, e.g. [confirm: reissue both invoices dated the same day as usual?].
Facts found in the provided past emails or knowledge base may be stated; decisions and commitments may not.
Address each distinct question; a placeholder counts as addressing it.
End the reply without a sign-off or the user's name; their signature is added automatically.
Never use a placeholder for the user's name. Do not add a signature or sign-off.
Inline image markers such as [image] or [image: ...] mean the sender included a real image in the email, but only the marker and label are available in this prompt. Do not say the image is missing, unreadable, unavailable, or needs to be resent; respond from the available text and image label.
Treat email dates as message metadata, not calendar context.
Do not use em dashes unless the provided writing style explicitly calls for them.
Don't suggest meeting times or mention availability unless specific calendar information is provided.
When the sender provides a scheduling link or scheduling process, use that path instead of adding the user's booking link.

Write an email that follows up on the previous conversation.
Your reply should aim to continue the conversation or provide new information based on the context or knowledge base. If you have nothing substantial to add, keep the reply minimal.
By default, keep replies concise, direct, friendly, plainspoken, and no longer than needed. Prefer short declarative sentences over polished or overly elaborate phrasing.
The user's writing style can override these defaults.

Example when the context does not contain the answer:
Sender: "Can you confirm the workshop fee is $500 and we're booked for Friday?" (the context has no fee or booking)
Good: "Thanks. [confirm: is the fee $500?] [confirm: are we booked for Friday?]"
Bad: "Yes, $500 and Friday are both right."
`;

const defaultWritingStyle = `Keep it concise, direct, and friendly.
Keep the reply short. Aim for 2 sentences at most unless a brief answer to multiple questions needs more.
Don't be pushy.
Write in a plainspoken, professional tone.
Prefer short declarative sentences over polished or overly elaborate phrasing.`;

/**
 * Appended whenever a user's own style replaces the default above, because
 * otherwise the only length guidance in the prompt disappears for them — which
 * is nearly everyone who has used the product long enough to have a style.
 *
 * Deliberately about proportionality rather than a sentence count. A user whose
 * style asks for thorough replies is not contradicted by this: a long answer to
 * a complex question is still proportionate. It only rules out padding,
 * restatement, and unrequested additions, which no style asks for.
 */
const LENGTH_DISCIPLINE =
  "Match the length of the reply to what was actually asked. Do not restate the incoming message, pad with filler, or add offers, next steps, or availability that nobody requested.";

type DraftEmailAccount = EmailAccountWithAI & {
  bookingLinks?: { slug: string }[];
};

export type DraftReplyInput = {
  messages: (EmailForLLM & { to: string })[];
  emailAccount: DraftEmailAccount;
  /** The user's other send-as addresses, besides `emailAccount.email`. */
  sendAsEmails?: string[];
  knowledgeBaseContent: string | null;
  replyMemoryContent?: string | null;
  emailHistorySummary: string | null;
  emailHistoryContext: ReplyContextCollectorResult | null;
  senderReplyExamples?: string | null;
  calendarAvailability: CalendarAvailabilityContext | null;
  writingStyle: string | null;
  learnedWritingStyle?: string | null;
  mcpContext: string | null;
  meetingContext: string | null;
  recordedMeetingContext?: string | null;
  attachmentContext?: string | null;
  hasConfiguredSignature?: boolean;
  currentDate?: Date;
};

type DraftReplyModelContextInput = {
  emailAccount: Pick<
    DraftEmailAccount,
    "about" | "timezone" | "calendarBookingLink" | "bookingLinks"
  >;
  knowledgeBaseContent: string | null;
  replyMemoryContent: string | null;
  emailHistorySummary: string | null;
  emailHistoryContext: ReplyContextCollectorResult | null;
  senderReplyExamples: string | null;
  calendarAvailability: CalendarAvailabilityContext | null;
  writingStyle: string | null;
  learnedWritingStyle: string | null;
  mcpContext: string | null;
  meetingContext: string | null;
  recordedMeetingContext: string | null;
  attachmentContext: string | null;
  hasConfiguredSignature: boolean;
};

export type DraftReplyModelEvidence = {
  thread: string;
  context: string;
  temporalAndIdentityContext: string;
};

const getUserPrompt = (input: DraftReplyInput) => {
  const { thread, context, temporalAndIdentityContext } =
    buildDraftReplyModelEvidence(input);

  return `${context}

Here is the context of the email thread (from oldest to newest):
${thread}

Please write a reply to the email.
Answer the sender directly as the user. If the answer depends on something only the user knows and the context does not show it, leave a [placeholder] for the user to fill in.
${temporalAndIdentityContext}`;
};

export function buildDraftReplyModelEvidence({
  messages,
  emailAccount,
  sendAsEmails = [],
  currentDate = new Date(),
  replyMemoryContent = null,
  senderReplyExamples = null,
  learnedWritingStyle = null,
  attachmentContext = null,
  hasConfiguredSignature = false,
  recordedMeetingContext = null,
  ...modelContextInput
}: DraftReplyInput): DraftReplyModelEvidence {
  const modelContext = buildDraftReplyModelContext({
    ...modelContextInput,
    emailAccount,
    replyMemoryContent,
    senderReplyExamples,
    learnedWritingStyle,
    attachmentContext,
    hasConfiguredSignature,
    recordedMeetingContext,
  });
  const thread = getEmailListPrompt({ messages, messageMaxLength: 3000 });
  const temporalAndIdentityContext = `${getTodayForLLM(currentDate)}
IMPORTANT: You are writing an email as ${emailAccount.email}${sendAsEmails.length ? ` (also sends as ${sendAsEmails.join(", ")})` : ""}. Write the reply from their perspective.`;

  return {
    thread,
    context: modelContext,
    temporalAndIdentityContext,
  };
}

/**
 * The complete non-thread context shown to the drafting model. Eval judges use
 * this same resolved representation so product precedence and formatting rules
 * cannot drift between generation and grading.
 */
export function buildDraftReplyModelContext({
  emailAccount,
  knowledgeBaseContent,
  replyMemoryContent,
  emailHistorySummary,
  emailHistoryContext,
  senderReplyExamples,
  calendarAvailability,
  writingStyle,
  learnedWritingStyle,
  mcpContext,
  meetingContext,
  recordedMeetingContext,
  attachmentContext,
  hasConfiguredSignature,
}: DraftReplyModelContextInput): string {
  const normalizedWritingStyle = writingStyle?.trim() || null;
  const normalizedLearnedWritingStyle = learnedWritingStyle?.trim() || null;
  const customWritingStyle =
    normalizedWritingStyle || normalizedLearnedWritingStyle;
  const effectiveWritingStyle = customWritingStyle
    ? `${customWritingStyle}\n\n${LENGTH_DISCIPLINE}`
    : defaultWritingStyle;
  const advisoryLearnedWritingStyle = normalizedWritingStyle
    ? normalizedLearnedWritingStyle
    : null;
  const userAbout = getUserAboutPrompt(emailAccount.about);

  const relevantKnowledge = knowledgeBaseContent
    ? `Relevant knowledge base content:

<knowledge_base>
${knowledgeBaseContent}
</knowledge_base>
`
    : "";

  const learnedReplyMemories = replyMemoryContent
    ? `Learned reply memories from prior draft edits. These are advisory, not mandatory. Use them only when they clearly help with the current email, and ignore any memory that does not fit. Explicit user instructions and knowledge base content take precedence.

<reply_memories>
${replyMemoryContent}
</reply_memories>
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
    ? `Advisory context from similar email threads that may help draft a reply.

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

  const senderReplyExamplesContext = senderReplyExamples
    ? `Past replies to this sender. Use for relationship, tone, brevity, and directness; current thread/context facts still win.

<sender_reply_examples>
${senderReplyExamples}
</sender_reply_examples>
`
    : "";

  const writingStylePrompt = getWritingStylePrompt(effectiveWritingStyle);

  const learnedWritingStylePrompt = advisoryLearnedWritingStyle
    ? `Learned writing style from prior draft edits. This is advisory and lower priority than any explicit writing style provided by the user.

<learned_writing_style>
${advisoryLearnedWritingStyle}
</learned_writing_style>
`
    : "";

  const schedulingContext = getSchedulingContext({
    calendarBookingLink: getCalendarBookingLinkForDraft(emailAccount),
    calendarAvailability,
    userTimezone: calendarAvailability?.timezone || emailAccount.timezone,
  });

  const mcpToolsContext = mcpContext
    ? `Additional context fetched from external tools (such as CRM systems, task managers, or other integrations) that may help draft a response:

<external_tools_context>
${mcpContext}
</external_tools_context>
`
    : "";

  const missingExternalContext =
    !knowledgeBaseContent &&
    !emailHistorySummary &&
    !emailHistoryContext?.relevantEmails.length &&
    !mcpContext &&
    !meetingContext &&
    !recordedMeetingContext &&
    !attachmentContext
      ? `No additional factual context was provided beyond the email thread.
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
  const signatureContext = hasConfiguredSignature
    ? `The user's email account already has a configured signature that will be appended after this draft. Do not write any closing, sign-off, name, title, contact details, or signature block.
`
    : "";

  return `${userAbout}
${relevantKnowledge}
${learnedReplyMemories}
${historicalContext}
${precedentHistoryContext}
${senderReplyExamplesContext}
${writingStylePrompt}
${learnedWritingStylePrompt}
${signatureContext}
${schedulingContext}
${mcpToolsContext}
${missingExternalContext}
${upcomingMeetingsContext}
${recordedMeetingContext || ""}
${selectedAttachments}`;
}

const llmDraftConfidenceSchema = z.enum(["LOW", "MEDIUM", "HIGH"]);

const draftSchema = z.object({
  reply: z
    .string()
    .describe(
      "The complete email reply draft incorporating knowledge base information",
    ),
  confidence: llmDraftConfidenceSchema.describe(
    "Use HIGH only when the draft is complete, grounded, and does not depend on missing facts, pending checks or follow-ups, unavailable calendar/business state, assumptions, or user-fillable details. Use MEDIUM only for complete, grounded drafts with minor wording uncertainty. Use LOW whenever anything rests on an assumption, a missing fact or a [placeholder], and when the draft is highly uncertain, likely needs broader thread/context review, or mainly asks/checks/follows up.",
  ),
});

export type DraftReplyResult = {
  reply: string;
  confidence: DraftReplyConfidence;
  attribution: DraftAttribution | null;
};

export async function aiDraftReplyWithConfidence(
  input: DraftReplyInput,
): Promise<DraftReplyResult> {
  const {
    messages,
    emailAccount,
    knowledgeBaseContent,
    emailHistorySummary,
    calendarAvailability,
  } = input;
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

  const prompt = getUserPrompt(input);

  const modelOptions = getModelForUseCase(
    emailAccount.user,
    LlmUseCase.DraftReply,
  );
  const attributionTracker = createDraftAttributionTracker();

  const generateObject = createGenerateObject({
    emailAccount,
    label: "Draft reply",
    modelOptions,
    promptHardening: { trust: "untrusted", level: "full" },
    onModelUsed: attributionTracker.onModelUsed,
  });

  const generate = () =>
    generateObject({
      ...modelOptions,
      instructions: appendOllamaOnlySystemGuidance(
        { instructions: systemPrompt },
        modelOptions,
        OLLAMA_DRAFT_RESPONSE_GUIDANCE,
      ).instructions,
      prompt,
      schema: draftSchema,
      // Overrides the generic repair, which cannot turn bare email text into
      // an object that matches draftSchema.
      repairText: async ({ text }: { text: string }) =>
        repairDraftReplyText(text),
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
      : mapLlmDraftConfidence(result.object.confidence),
    attribution: attributionTracker.attribution,
  };
}

export async function aiDraftReply(input: DraftReplyInput) {
  const result = await aiDraftReplyWithConfidence(input);

  return result.reply;
}

export function normalizeDraftReplyFormatting(reply: string): string {
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

  const withRepairedCollapsedParagraphs =
    repairCollapsedParagraphBoundaries(cleaned);

  const nonEmptyLines = withRepairedCollapsedParagraphs
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (shouldConvertSingleLineBreaksToParagraphs(nonEmptyLines)) {
    return nonEmptyLines.join("\n\n");
  }

  return withRepairedCollapsedParagraphs;
}

function repairCollapsedParagraphBoundaries(reply: string): string {
  if (reply.includes("\n")) return reply;

  const gluedSentenceBoundaryPattern = /([a-z0-9][.!?])(?=[A-Z])/g;
  const boundaryMatches = reply.match(gluedSentenceBoundaryPattern);

  if (!boundaryMatches || boundaryMatches.length < 2) return reply;

  return reply.replace(gluedSentenceBoundaryPattern, "$1\n\n");
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

/**
 * Exported so the eval harness inverts this rather than restating it. The
 * harness reports the model-facing label, and a silent remap here would
 * otherwise leave it reporting the old semantics with nothing failing.
 */
export const DRAFT_CONFIDENCE_BY_LLM_LABEL = {
  LOW: DraftReplyConfidence.ALL_EMAILS,
  MEDIUM: DraftReplyConfidence.STANDARD,
  HIGH: DraftReplyConfidence.HIGH_CONFIDENCE,
} as const;

function mapLlmDraftConfidence(confidence: unknown): DraftReplyConfidence {
  const llmConfidence = llmDraftConfidenceSchema.safeParse(confidence);
  if (!llmConfidence.success) {
    return normalizeDraftReplyConfidence(confidence);
  }

  return DRAFT_CONFIDENCE_BY_LLM_LABEL[llmConfidence.data];
}

// Matches any non-separator, non-whitespace character repeated 50+ times in a row
const REPETITIVE_TEXT_PATTERN = /([^\s\-=_*.#~])\1{49,}/u;

function getSchedulingContext({
  calendarBookingLink,
  calendarAvailability,
  userTimezone,
}: {
  calendarBookingLink: string | null;
  calendarAvailability: CalendarAvailabilityContext | null;
  userTimezone: string | null | undefined;
}): string {
  const parts: string[] = [];
  const timezone = userTimezone || "UTC";

  if (calendarBookingLink) {
    parts.push(`<booking_link>
${calendarBookingLink}
</booking_link>

When scheduling with the user is clearly needed, prefer sharing this booking link over listing specific availability. Do not use it as a default call-to-action for non-scheduling emails.`);
  }

  if (calendarAvailability?.noAvailability) {
    const timezoneLabel = getTimezoneLabel(timezone);

    parts.push(`The user has no available time slots in the requested timeframe in ${timezoneLabel}.
Do not suggest specific times, and do not decline or reschedule for the user. Leave the decision in a placeholder (e.g., "[confirm: your calendar is full tomorrow; decline or offer another day?]"${calendarBookingLink ? " or share the booking link" : ""}).`);
  } else if (calendarAvailability?.suggestedTimes.length) {
    const times = calendarAvailability.suggestedTimes
      .map((slot) =>
        formatAvailableSlotForPrompt(
          slot,
          timezone,
          getTimezoneLabel(timezone, slot.start),
        ),
      )
      .join("\n");
    const timezoneLabels = getTimezoneLabelsForSlots(
      timezone,
      calendarAvailability.suggestedTimes,
    );

    parts.push(`Available time slots are in ${timezoneLabels}.
Quote slot times exactly as listed, with their timezone label; never convert them to another timezone.
If you list specific times, include the user-facing timezone label shown for each slot, not a raw timezone identifier.

Available time slots:
${times}

${calendarBookingLink ? "Because the user has a booking link, share the booking link instead of listing specific times unless the sender explicitly asks the user to provide times, asks about a specific proposed time/date, or the booking link would not answer the scheduling request." : "When the sender is asking to schedule, respond using these time slots. Treat supplied slots on or after today's date as valid; only ask for updated availability if every supplied slot is before today's date."} These times are free on the user's calendar; offer them only inside a [confirm: ...] placeholder, never as an acceptance. Propose one specific time rather than a list unless the sender asked for multiple options. If the sender asked for a specific number of options, provide that many when enough slots are available. If the sender has already declined one proposal, offer a different specific time.`);
  }

  if (parts.length === 0) return "";

  return `Scheduling context:

<scheduling>
${parts.join("\n\n")}
</scheduling>
`;
}

export function getCalendarBookingLinkForDraft(
  emailAccount: Pick<DraftEmailAccount, "bookingLinks" | "calendarBookingLink">,
) {
  const inboxZeroBookingLink = emailAccount.bookingLinks?.[0];

  if (inboxZeroBookingLink) {
    return `${env.NEXT_PUBLIC_BASE_URL.replace(/\/$/, "")}/book/${inboxZeroBookingLink.slug}`;
  }

  return emailAccount.calendarBookingLink;
}

function formatAvailableSlotForPrompt(
  slot: { start: string; end: string },
  timezone: string,
  timezoneLabel: string,
): string {
  const utcStart = formatLocalSlotTimeAsUtc(slot.start, timezone);
  const utcEnd = formatLocalSlotTimeAsUtc(slot.end, timezone);

  if (!utcStart || !utcEnd) {
    return `- ${slot.start} to ${slot.end}`;
  }

  return `- ${slot.start} to ${slot.end} (${timezoneLabel}; UTC ${utcStart} to ${utcEnd})`;
}

function formatLocalSlotTimeAsUtc(
  localTime: string,
  timezone: string,
): string | null {
  const match = localTime.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);

  if (!match) return null;

  const [, year, month, day, hour, minute] = match;
  const date = new TZDate(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    0,
    0,
    timezone,
  );

  const utcDate = new Date(date.getTime());
  if (Number.isNaN(utcDate.getTime())) return null;

  return utcDate.toISOString().slice(0, 16).replace("T", " ");
}

function getTimezoneLabel(timezone: string, localTime?: string): string {
  if (timezone === "UTC") return "UTC";

  const date = localTime
    ? createDateFromLocalTime(localTime, timezone)
    : new Date();

  for (const style of [
    "short",
    "shortOffset",
    "shortGeneric",
    "longOffset",
  ] as const) {
    const label = getIntlTimezoneName(timezone, date, style);
    if (label && !looksLikeIanaTimezoneIdentifier(label)) return label;
  }

  return "UTC";
}

function looksLikeIanaTimezoneIdentifier(label: string): boolean {
  return label.includes("/");
}

function getTimezoneLabelsForSlots(
  timezone: string,
  slots: { start: string }[],
): string {
  const labels = [
    ...new Set(slots.map((slot) => getTimezoneLabel(timezone, slot.start))),
  ];

  return labels.join("/");
}

function createDateFromLocalTime(localTime: string, timezone: string): Date {
  const match = localTime.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);

  if (!match) return new Date();

  const [, year, month, day, hour, minute] = match;

  return new TZDate(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    0,
    0,
    timezone,
  );
}

function getIntlTimezoneName(
  timezone: string,
  date: Date,
  timeZoneName: "short" | "shortOffset" | "shortGeneric" | "longOffset",
): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName,
    }).formatToParts(date);

    return (
      parts.find((part) => part.type === "timeZoneName")?.value.trim() || null
    );
  } catch {
    return null;
  }
}

const OLLAMA_DRAFT_RESPONSE_GUIDANCE = [
  'Return a JSON object with exactly two top-level fields: "reply" and "confidence".',
  '"reply" must be one complete email reply as a single plain-text string, not an array of alternatives.',
  '"confidence" must be one of "LOW", "MEDIUM", or "HIGH".',
  'Example valid output: {"reply":"Thanks for the details. [confirm: does Friday at 4 pm work?]","confidence":"LOW"}',
] as const;

export function repairDraftReplyText(text: string): string {
  if (!text.trim()) return text;

  const parsed = parseJsonObject(text);
  if (parsed && typeof parsed.reply === "string") {
    // A missing or invented confidence would fail the schema; the lowest one
    // keeps the user reviewing the draft.
    const confidence = llmDraftConfidenceSchema.safeParse(parsed.confidence)
      .success
      ? parsed.confidence
      : "LOW";
    return JSON.stringify({ ...parsed, confidence });
  }

  // Some models ignore the schema and answer with the bare email. The lowest
  // confidence keeps the user reviewing it.
  return JSON.stringify({ reply: text.trim(), confidence: "LOW" });
}

export function hasDraftPlaceholder(reply: string): boolean {
  // The lookahead skips markdown links, `[label](url)`.
  for (const match of reply.matchAll(/\[([^[\]]{2,200})\](?!\()/g)) {
    if (!MAIL_TAGS.has(match[1].trim().toLowerCase())) return true;
  }
  return false;
}

// Subject tags mail systems add; echoing one is not a decision left open.
const MAIL_TAGS = new Set(["external", "spam", "suspicious"]);

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
