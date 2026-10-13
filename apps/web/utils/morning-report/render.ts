import type { CalendarEvent } from "@/utils/calendar/event-types";
import { formatInUserTimezone, ONE_DAY_MS } from "@/utils/date";
import { extractEmailAddress } from "@/utils/email";
import { prefixPath } from "@/utils/path";
import type {
  ReportSection,
  ReportSelection,
} from "@/utils/ai/morning-report/select-items";
import { type Candidate, normalizeSubject } from "./candidates";
import type { ConnectionProblem } from "./health";
import type { ReplyItem } from "./reply-state";

// Telegram cuts at 4096 and the adapter adds nothing; keep headroom.
export const MAX_REPORT_CHARS = 3800;

const SECTIONS_BEFORE_TODAY: ReportSection[] = [
  "money",
  "deadline",
  "security",
];
const SECTIONS_AFTER_TODAY: ReportSection[] = ["action", "reply", "waiting"];
const SECTION_HEADERS: Record<ReportSection, string> = {
  money: "💰 Money",
  deadline: "⏰ Deadlines",
  security: "🔐 Security",
  action: "✅ To do",
  reply: "✉️ Reply needed",
  waiting: "⏳ Waiting on others",
};

export type RenderInput = {
  now: Date;
  timeZone: string;
  since: Date;
  previousRunMissed: boolean;
  selection: ReportSelection;
  selectionFailed: boolean;
  calendarFailures: string[];
  candidates: Candidate[];
  replyItems: ReplyItem[];
  events: { accountEmail: string; event: CalendarEvent }[];
  bulkCounts: Record<string, number>;
  staleReplyCount: number;
  unverifiedReplyCount: number;
  problems: ConnectionProblem[];
  failures: { email: string; error: string }[];
  truncatedAccounts: string[];
  baseUrl: string;
};

export function renderMorningReport(input: RenderInput): string {
  const { now, timeZone } = input;
  const blocks: string[][] = [];

  const header = [
    `☀️ Morning report — ${formatInUserTimezone(now, timeZone, "EEE d MMM")}`,
  ];
  if (input.previousRunMissed) {
    header.push(
      `Covers mail since ${formatInUserTimezone(input.since, timeZone, "EEE d MMM, HH:mm")} — an earlier report was missed.`,
    );
  }

  const problems = problemLines(input);
  if (problems.length) blocks.push(["⚠️ Problems", ...problems]);

  const linesBySection = selectedLines(input);
  for (const section of SECTIONS_BEFORE_TODAY)
    pushSection(blocks, section, linesBySection);

  const today = eventLines(input);
  if (today.length) blocks.push(["📅 Today", ...today]);

  for (const section of SECTIONS_AFTER_TODAY)
    pushSection(blocks, section, linesBySection);

  const hasContent = blocks.length > (problems.length ? 1 : 0);
  if (!hasContent) {
    blocks.push([
      problems.length
        ? "Nothing else needs you today."
        : "Nothing needs you today.",
    ]);
  }

  const body = [header, ...blocks]
    .map((block) => block.join("\n"))
    .join("\n\n");
  return capLength(body, footerLine(input));
}

export function accountTag(email: string) {
  const [local = "", domain = ""] = email.toLowerCase().split("@");
  // ponytail: two mailboxes on the same provider/domain share a tag; add the
  // local part if that ever happens.
  return domain.split(".")[0] || local;
}

function problemLines(input: RenderInput) {
  const lines = input.problems.map((problem) =>
    problem.problem === "mailbox"
      ? `• ${problem.email}: mailbox disconnected, not checked. Reconnect: ${input.baseUrl}${prefixPath(problem.emailAccountId, "/permissions/consent")}`
      : `• ${problem.email}: calendar access expired, today's meetings may be missing. Reconnect it in Settings.`,
  );
  for (const failure of input.failures) {
    lines.push(
      `• ${failure.email}: could not be read (${truncate(failure.error, 150)})`,
    );
  }
  for (const email of input.calendarFailures) {
    lines.push(
      `• ${email}: calendar could not be read, so today's meetings may be missing`,
    );
  }
  if (input.selectionFailed) {
    lines.push(
      "• The report model returned unusable output; check the app for today's mail",
    );
  }
  if (input.unverifiedReplyCount) {
    lines.push(
      `• ${input.unverifiedReplyCount} reply threads could not be checked; reply lists may be incomplete`,
    );
  }
  for (const email of input.truncatedAccounts) {
    lines.push(`• ${email}: more mail than one report covers; oldest left out`);
  }
  return lines;
}

function selectedLines(input: RenderInput) {
  const candidates = new Map(input.candidates.map((c) => [c.id, c]));
  const replies = new Map(input.replyItems.map((r) => [r.id, r]));
  // section -> dedupe key -> line parts
  const bySection = new Map<
    ReportSection,
    Map<string, { text: string; tags: string[] }>
  >();

  for (const item of input.selection.items) {
    const candidate = candidates.get(item.id);
    const reply = replies.get(item.id);
    const accountEmail = candidate?.accountEmail ?? reply?.accountEmail;
    if (!accountEmail) continue;

    const key = candidate
      ? `${extractEmailAddress(candidate.from).toLowerCase()}|${normalizeSubject(candidate.subject)}`
      : item.id;
    const base = item.note || candidate?.subject || reply?.subject || "";
    const age = reply
      ? ` · ${Math.max(0, Math.floor((input.now.getTime() - reply.sentAt.getTime()) / ONE_DAY_MS))}d`
      : "";

    const section = bySection.get(item.section) ?? new Map();
    const existing = section.get(key);
    const tag = accountTag(accountEmail);
    if (existing) {
      if (!existing.tags.includes(tag)) existing.tags.push(tag);
    } else {
      section.set(key, { text: `${base}${age}`, tags: [tag] });
    }
    bySection.set(item.section, section);
  }

  return new Map(
    [...bySection].map(([section, lines]) => [
      section,
      [...lines.values()].map(
        (line) => `• ${line.text} [${line.tags.join(", ")}]`,
      ),
    ]),
  );
}

function pushSection(
  blocks: string[][],
  section: ReportSection,
  linesBySection: Map<ReportSection, string[]>,
) {
  const lines = linesBySection.get(section);
  if (lines?.length) blocks.push([SECTION_HEADERS[section], ...lines]);
}

function eventLines({ events, timeZone }: RenderInput) {
  const seen = new Map<
    string,
    { line: string; tags: string[]; start: number }
  >();
  for (const { accountEmail, event } of events) {
    const key = `${event.title}|${event.startTime.getTime()}`;
    const tag = accountTag(accountEmail);
    const existing = seen.get(key);
    if (existing) {
      if (!existing.tags.includes(tag)) existing.tags.push(tag);
      continue;
    }
    const time = `${formatInUserTimezone(event.startTime, timeZone, "HH:mm")}–${formatInUserTimezone(event.endTime, timeZone, "HH:mm")}`;
    seen.set(key, {
      line: `${time} ${event.title}`,
      tags: [tag],
      start: event.startTime.getTime(),
    });
  }
  return [...seen.values()]
    .sort((a, b) => a.start - b.start)
    .map((entry) => `• ${entry.line} [${entry.tags.join(", ")}]`);
}

function footerLine({
  bulkCounts,
  staleReplyCount,
  candidates,
  selection,
}: RenderInput) {
  const parts: string[] = [];
  const candidateIds = new Set(candidates.map((c) => c.id));
  const picked = new Set(
    selection.items.map((i) => i.id).filter((id) => candidateIds.has(id)),
  );
  const otherReviewed = candidateIds.size - picked.size;
  const bulk = Object.entries(bulkCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => `${count} ${name}`);
  if (bulk.length) parts.push(bulk.join(", "));
  if (otherReviewed) parts.push(`${otherReviewed} other emails reviewed`);
  if (staleReplyCount)
    parts.push(`${staleReplyCount} reply threads older than 30 days`);
  return parts.length ? `Skipped: ${parts.join(" · ")}` : null;
}

function capLength(body: string, footer: string | null) {
  const suffix = footer ? `\n\n${footer}` : "";
  if (body.length + suffix.length <= MAX_REPORT_CHARS) return body + suffix;
  const lines = body.split("\n");
  const kept: string[] = [];
  let length = 0;
  const reserve = 60;
  for (const line of lines) {
    if (length + line.length + 1 > MAX_REPORT_CHARS - suffix.length - reserve)
      break;
    kept.push(line);
    length += line.length + 1;
  }
  // Drop a trailing blank line or a section header whose items were cut.
  while (
    kept.length > 1 &&
    (kept.at(-1) === "" ||
      (kept.at(-2) === "" && !kept.at(-1)?.startsWith("•")))
  ) {
    kept.pop();
  }
  return `${kept.join("\n")}\n…and ${lines.length - kept.length} more lines — open Inbox for the rest.${suffix}`;
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
