import { z } from "zod";
import { NewsletterStatus } from "@/generated/prisma/enums";
import type { Logger } from "@/utils/logger";
import { ConflictError, StaleStateError } from "@/utils/mcp-server/errors";
import { getHttpUnsubscribeLink } from "@/utils/parse/unsubscribe";
import prisma from "@/utils/prisma";
import { extractEmailOrThrow } from "@/utils/senders/record";
import { unsubscribeSenderAndMark } from "@/utils/senders/unsubscribe";

export type UnsubDomainCtx = { userId: string; emailAccountId: string };

export const listUnsubscribeCandidatesInput = z.object({
  status: z.nativeEnum(NewsletterStatus).optional(),
  limit: z.number().int().positive().max(500).optional(),
});
export type ListUnsubscribeCandidatesInput = z.infer<
  typeof listUnsubscribeCandidatesInput
>;

export type UnsubscribeCandidate = {
  id: string;
  email: string;
  name: string | null;
  status: NewsletterStatus | null;
  createdAt: Date;
  updatedAt: Date;
};

export async function listUnsubscribeCandidates(
  ctx: UnsubDomainCtx,
  rawInput: ListUnsubscribeCandidatesInput,
): Promise<{ senders: UnsubscribeCandidate[]; total: number }> {
  const input = listUnsubscribeCandidatesInput.parse(rawInput);
  const take = input.limit ?? 200;
  const where = {
    emailAccountId: ctx.emailAccountId,
    ...(input.status ? { status: input.status } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.newsletter.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take,
      select: {
        id: true,
        email: true,
        name: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.newsletter.count({ where }),
  ]);
  return { senders: rows, total };
}

export const requestUnsubscribeInput = z.object({
  newsletterEmail: z.string().email(),
  unsubscribeLink: z.string().nullish(),
  listUnsubscribeHeader: z.string().nullish(),
  confirm: z.boolean().default(false),
});
export type RequestUnsubscribeInput = z.infer<typeof requestUnsubscribeInput>;

export type RequestUnsubscribeCtx = UnsubDomainCtx & { logger: Logger };

export type RequestUnsubscribePreview = {
  targetEmail: string;
  targetUrl: string | null;
  method: "http" | "mailto" | "none";
};

export type RequestUnsubscribeResult =
  | { dryRun: true; preview: RequestUnsubscribePreview }
  | {
      dryRun: false;
      data: Awaited<ReturnType<typeof unsubscribeSenderAndMark>>;
    };

export async function requestUnsubscribe(
  ctx: RequestUnsubscribeCtx,
  rawInput: RequestUnsubscribeInput,
): Promise<RequestUnsubscribeResult> {
  const input = requestUnsubscribeInput.parse(rawInput);
  const senderEmail = extractEmailOrThrow(input.newsletterEmail);

  const httpUrl = getHttpUnsubscribeLink({
    unsubscribeLink: input.unsubscribeLink ?? undefined,
    listUnsubscribeHeader: input.listUnsubscribeHeader ?? undefined,
  });

  let method: "http" | "mailto" | "none" = "none";
  let targetUrl: string | null = null;
  if (httpUrl) {
    method = "http";
    targetUrl = httpUrl;
  } else if (input.listUnsubscribeHeader?.toLowerCase().includes("mailto:")) {
    method = "mailto";
    const match = input.listUnsubscribeHeader.match(/mailto:([^>,\s]+)/i);
    targetUrl = match ? match[1] : null;
  }

  if (!input.confirm) {
    return {
      dryRun: true,
      preview: { targetEmail: senderEmail, targetUrl, method },
    };
  }

  // STALE_STATE: don't re-fire if already unsubscribed.
  const existing = await prisma.newsletter.findUnique({
    where: {
      email_emailAccountId: {
        email: senderEmail,
        emailAccountId: ctx.emailAccountId,
      },
    },
    select: { status: true },
  });
  if (existing?.status === NewsletterStatus.UNSUBSCRIBED) {
    throw new StaleStateError(
      `STALE_STATE: sender ${senderEmail} is already marked UNSUBSCRIBED`,
    );
  }

  if (method === "mailto") {
    throw new ConflictError(
      "mailto: unsubscribe execution is not implemented; use the http URL or send the unsubscribe email manually",
    );
  }

  if (method === "none") {
    throw new ConflictError("No unsubscribe URL available for this sender");
  }

  const data = await unsubscribeSenderAndMark({
    emailAccountId: ctx.emailAccountId,
    newsletterEmail: senderEmail,
    unsubscribeLink: input.unsubscribeLink ?? null,
    listUnsubscribeHeader: input.listUnsubscribeHeader ?? null,
    logger: ctx.logger,
  });

  return { dryRun: false, data };
}
