import { SystemType } from "@/generated/prisma/enums";
import { internalDateToDate, sortByInternalDate } from "@/utils/date";
import { extractEmailAddress } from "@/utils/email";
import type { EmailProvider } from "@/utils/email/types";
import prisma from "@/utils/prisma";
import type { ParsedMessage } from "@/utils/types";

// ponytail: hard cap per mailbox per report; a week-long gap on a busy mailbox
// is the ceiling. The report says "truncated" when hit — raise it then.
const MAX_MESSAGES = 400;
const PAGE_SIZE = 100;
const SNIPPET_LENGTH = 160;

// Only these are safe to drop unseen. NOTIFICATION is deliberately kept: the
// user's Notification rule swallows App Store build failures, GitHub access
// requests and KYC deadlines alongside the true noise.
const BULK_SYSTEM_TYPES = new Set<string>([
  SystemType.MARKETING,
  SystemType.NEWSLETTER,
  SystemType.COLD_EMAIL,
]);

type RuleTag = { name: string; systemType: string | null };

export type Candidate = {
  id: string;
  accountEmail: string;
  messageId: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  date: Date;
  rules: string[];
  count: number;
};

export type CandidateSet = {
  candidates: Candidate[];
  bulkCounts: Record<string, number>;
  truncated: boolean;
};

export async function collectCandidates({
  accountIndex,
  accountEmail,
  emailAccountId,
  provider,
  since,
}: {
  accountIndex: number;
  accountEmail: string;
  emailAccountId: string;
  provider: EmailProvider;
  since: Date;
}): Promise<CandidateSet> {
  const { messages, truncated } = await listReceivedSince({ provider, since });

  const executedRules = await prisma.executedRule.findMany({
    where: { emailAccountId, messageId: { in: messages.map((m) => m.id) } },
    select: {
      messageId: true,
      rule: { select: { name: true, systemType: true } },
    },
  });

  const rulesByMessage = new Map<string, RuleTag[]>();
  for (const executed of executedRules) {
    if (!executed.rule) continue;
    const tags = rulesByMessage.get(executed.messageId) ?? [];
    tags.push(executed.rule);
    rulesByMessage.set(executed.messageId, tags);
  }

  return {
    ...foldCandidates({ accountIndex, accountEmail, messages, rulesByMessage }),
    truncated,
  };
}

export function foldCandidates({
  accountIndex,
  accountEmail,
  messages,
  rulesByMessage,
}: {
  accountIndex: number;
  accountEmail: string;
  messages: ParsedMessage[];
  rulesByMessage: Map<string, RuleTag[]>;
}) {
  const bulkCounts: Record<string, number> = {};
  // ponytail: key is sender + normalized subject. Long hashes and bank refs fold;
  // short numbers (amounts, card endings) stay distinct. Same-subject mail still
  // shows only the newest, with its count. Keep extra snippets if that hides something.
  const groups = new Map<string, Candidate>();

  for (const message of [...messages].sort(sortByInternalDate("desc"))) {
    const rules = rulesByMessage.get(message.id) ?? [];
    const isBulk =
      rules.length > 0 &&
      rules.every(
        (rule) => rule.systemType && BULK_SYSTEM_TYPES.has(rule.systemType),
      );
    if (isBulk) {
      bulkCounts[rules[0].name] = (bulkCounts[rules[0].name] ?? 0) + 1;
      continue;
    }

    const subject =
      message.headers.subject || message.subject || "(no subject)";
    const key = `${extractEmailAddress(message.headers.from).toLowerCase()}|${normalizeSubject(subject)}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }

    groups.set(key, {
      id: "",
      accountEmail,
      messageId: message.id,
      threadId: message.threadId,
      from: message.headers.from,
      subject,
      snippet: cleanSnippet(message.snippet),
      date: internalDateToDate(message.internalDate),
      rules: [...new Set(rules.map((rule) => rule.name))],
      count: 1,
    });
  }

  const candidates = [...groups.values()].map((candidate, index) => ({
    ...candidate,
    id: `${accountIndex}.${index + 1}`,
  }));

  return { candidates, bulkCounts };
}

export function normalizeSubject(subject: string) {
  return subject
    .toLowerCase()
    .replace(/^((re|fwd?|aw):\s*)+/g, "")
    .replace(/\b(?=[0-9a-z]*\d)[0-9a-z]{7,}\b/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

async function listReceivedSince({
  provider,
  since,
}: {
  provider: EmailProvider;
  since: Date;
}) {
  const messages: ParsedMessage[] = [];
  let pageToken: string | undefined;

  do {
    const page = await provider.getMessagesWithPagination({
      after: since,
      inboxOnly: false,
      maxResults: PAGE_SIZE,
      pageToken,
    });
    messages.push(...page.messages.filter((m) => !provider.isSentMessage(m)));
    pageToken = page.nextPageToken;
  } while (pageToken && messages.length < MAX_MESSAGES);

  return {
    messages: messages.slice(0, MAX_MESSAGES),
    truncated: Boolean(pageToken) || messages.length > MAX_MESSAGES,
  };
}

function cleanSnippet(snippet: string) {
  return snippet
    .replace(/[͏­​-‍⁠﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SNIPPET_LENGTH);
}
