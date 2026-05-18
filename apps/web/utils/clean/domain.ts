import { after } from "next/server";
import { z } from "zod";
import { CleanAction } from "@/generated/prisma/enums";
import { ONE_DAY_MS } from "@/utils/date";
import { createEmailProvider } from "@/utils/email/provider";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { GmailLabel } from "@/utils/gmail/label";
import { inboxZeroLabels } from "@/utils/label";
import type { Logger } from "@/utils/logger";
import {
  ConflictError,
  ForbiddenError,
  StaleStateError,
  ValidationError,
} from "@/utils/mcp-server/errors";
import { isActivePremium } from "@/utils/premium";
import prisma from "@/utils/prisma";
import { isDefined } from "@/utils/types";
import { bulkPublishToQstash } from "@/utils/upstash";
import { getUserPremium } from "@/utils/user/get";
import { getUnhandledCount } from "@/utils/assess";
import {
  signPreviewToken,
  verifyPreviewToken,
} from "@/utils/clean/preview-token";
import type { CleanThreadBody } from "@/app/api/clean/route";

export type DomainCtx = { userId: string; emailAccountId: string };

export type ListCleanupJobsInput = { limit?: number };

export type CleanupJobSummary = {
  id: string;
  action: CleanAction;
  daysOld: number;
  instructions: string | null;
  threadCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export async function listCleanupJobs(
  ctx: DomainCtx,
  input: ListCleanupJobsInput,
): Promise<{ jobs: CleanupJobSummary[]; total: number }> {
  const take = Math.min(Math.max(input.limit ?? 50, 1), 200);

  const rows = await prisma.cleanupJob.findMany({
    where: { emailAccountId: ctx.emailAccountId },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      action: true,
      daysOld: true,
      instructions: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { threads: true } },
    },
  });

  const total = await prisma.cleanupJob.count({
    where: { emailAccountId: ctx.emailAccountId },
  });

  return {
    jobs: rows.map((r) => ({
      id: r.id,
      action: r.action,
      daysOld: r.daysOld,
      instructions: r.instructions,
      threadCount: r._count.threads,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    total,
  };
}

export const createCleanupJobInput = z.object({
  action: z.enum([CleanAction.ARCHIVE, CleanAction.MARK_READ]),
  daysOld: z.number().int().min(0).default(7),
  instructions: z.string().default(""),
  maxEmails: z.number().int().positive().optional(),
  skips: z.object({
    reply: z.boolean().default(true),
    starred: z.boolean().default(true),
    calendar: z.boolean().default(true),
    receipt: z.boolean().default(false),
    attachment: z.boolean().default(false),
    conversation: z.boolean().default(false),
  }),
  confirm: z.boolean().default(false),
  previewToken: z.string().optional(),
});
export type CreateCleanupJobInput = z.infer<typeof createCleanupJobInput>;

export type CreateCleanupJobCtx = DomainCtx & {
  provider: string;
  logger: Logger;
};

const STALE_DRIFT_PCT = 0.1;

export type CreateCleanupJobPreview = {
  matchedCount: number;
  previewToken: string;
  action: CleanAction;
  daysOld: number;
};

export type CreateCleanupJobResult =
  | { dryRun: true; preview: CreateCleanupJobPreview }
  | { dryRun: false; data: { jobId: string } };

export async function createCleanupJob(
  ctx: CreateCleanupJobCtx,
  rawInput: CreateCleanupJobInput,
): Promise<CreateCleanupJobResult> {
  const input = createCleanupJobInput.parse(rawInput);

  if (!isGoogleProvider(ctx.provider)) {
    throw new ConflictError(
      "Clean inbox is only supported for Google accounts",
    );
  }
  const premium = await getUserPremium({ userId: ctx.userId });
  if (!premium || !isActivePremium(premium)) {
    throw new ForbiddenError("Active premium required for cleanup");
  }

  const emailProvider = await createEmailProvider({
    emailAccountId: ctx.emailAccountId,
    provider: ctx.provider,
    logger: ctx.logger,
  });

  const matchedCount = await countMatchingThreads(emailProvider, input);

  if (!input.confirm) {
    const previewToken = signPreviewToken({
      matchedCount,
      generatedAt: Date.now(),
      emailAccountId: ctx.emailAccountId,
    });
    return {
      dryRun: true,
      preview: {
        matchedCount,
        previewToken,
        action: input.action,
        daysOld: input.daysOld,
      },
    };
  }

  if (input.previewToken) {
    const payload = verifyPreviewToken(input.previewToken, ctx.emailAccountId);
    if (!payload) {
      throw new ValidationError("Invalid previewToken");
    }
    const drift =
      Math.abs(matchedCount - payload.matchedCount) /
      Math.max(payload.matchedCount, 1);
    if (drift > STALE_DRIFT_PCT) {
      throw new StaleStateError(
        `STALE_STATE: preview matched ${payload.matchedCount} threads, now ${matchedCount}`,
      );
    }
  }

  const [markedDoneLabel, processedLabel] = await Promise.all([
    emailProvider.getOrCreateInboxZeroLabel(
      input.action === CleanAction.ARCHIVE ? "archived" : "marked_read",
    ),
    emailProvider.getOrCreateInboxZeroLabel("processed"),
  ]);
  const markedDoneLabelId = markedDoneLabel?.id;
  const processedLabelId = processedLabel?.id;
  if (!markedDoneLabelId || !processedLabelId) {
    throw new ConflictError("Failed to create cleanup labels");
  }

  const job = await prisma.cleanupJob.create({
    data: {
      emailAccountId: ctx.emailAccountId,
      action: input.action,
      instructions: input.instructions || null,
      daysOld: input.daysOld,
      skipReply: input.skips.reply,
      skipStarred: input.skips.starred,
      skipCalendar: input.skips.calendar,
      skipReceipt: input.skips.receipt,
      skipAttachment: input.skips.attachment,
      skipConversation: input.skips.conversation,
    },
  });

  after(() =>
    processCleanupJob({
      emailProvider,
      emailAccountId: ctx.emailAccountId,
      jobId: job.id,
      action: input.action,
      instructions: input.instructions,
      daysOld: input.daysOld,
      maxEmails: input.maxEmails,
      skips: input.skips,
      markedDoneLabelId,
      processedLabelId,
      logger: ctx.logger,
    }),
  );

  return { dryRun: false, data: { jobId: job.id } };
}

async function countMatchingThreads(
  emailProvider: Awaited<ReturnType<typeof createEmailProvider>>,
  input: CreateCleanupJobInput,
): Promise<number> {
  const { type } = await getUnhandledCount(emailProvider);
  const { threads } = await emailProvider.getThreadsWithQuery({
    query: {
      ...(input.daysOld > 0 && {
        before: new Date(Date.now() - input.daysOld * ONE_DAY_MS),
      }),
      labelIds:
        type === "inbox"
          ? [GmailLabel.INBOX]
          : [GmailLabel.INBOX, GmailLabel.UNREAD],
      excludeLabelNames: [inboxZeroLabels.processed.name],
    },
    maxResults: Math.min(input.maxEmails || 100, 100),
  });
  return threads.length;
}

async function processCleanupJob(args: {
  emailProvider: Awaited<ReturnType<typeof createEmailProvider>>;
  emailAccountId: string;
  jobId: string;
  action: CleanAction;
  instructions: string;
  daysOld: number;
  maxEmails?: number;
  skips: CreateCleanupJobInput["skips"];
  markedDoneLabelId: string;
  processedLabelId: string;
  logger: Logger;
}) {
  let nextPageToken: string | null | undefined;
  let total = 0;
  const { type } = await getUnhandledCount(args.emailProvider);
  do {
    const { threads, nextPageToken: pageToken } =
      await args.emailProvider.getThreadsWithQuery({
        query: {
          ...(args.daysOld > 0 && {
            before: new Date(Date.now() - args.daysOld * ONE_DAY_MS),
          }),
          labelIds:
            type === "inbox"
              ? [GmailLabel.INBOX]
              : [GmailLabel.INBOX, GmailLabel.UNREAD],
          excludeLabelNames: [inboxZeroLabels.processed.name],
        },
        maxResults: Math.min(args.maxEmails || 100, 100),
      });
    nextPageToken = pageToken;
    if (threads.length === 0) break;
    const items = threads
      .map((t) =>
        t.id
          ? {
              path: "/api/clean",
              body: {
                emailAccountId: args.emailAccountId,
                threadId: t.id,
                markedDoneLabelId: args.markedDoneLabelId,
                processedLabelId: args.processedLabelId,
                jobId: args.jobId,
                action: args.action,
                instructions: args.instructions,
                skips: args.skips,
              } satisfies CleanThreadBody,
              flowControl: {
                key: `ai-clean-${args.emailAccountId}`,
                parallelism: 3,
              },
            }
          : undefined,
      )
      .filter(isDefined);
    await bulkPublishToQstash({ items });
    total += items.length;
  } while (nextPageToken && (!args.maxEmails || total < args.maxEmails));
}
