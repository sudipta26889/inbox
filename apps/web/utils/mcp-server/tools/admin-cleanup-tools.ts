import { z } from "zod";
import {
  createCleanupJob,
  createCleanupJobInput,
  listCleanupJobs,
} from "@/utils/clean/domain";
import { createScopedLogger } from "@/utils/logger";
import type { McpResult } from "@/utils/mcp-server/envelope";
import { mapDomainError } from "@/utils/mcp-server/error-mapper";
import { ValidationError } from "@/utils/mcp-server/errors";
import prisma from "@/utils/prisma";
import type { McpToolContext } from "./registry";

const logger = createScopedLogger("mcp-admin-cleanup");

const listInput = z.object({
  limit: z.number().int().positive().max(200).optional(),
});

export async function adminCleanupListJobs(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResult<Awaited<ReturnType<typeof listCleanupJobs>>>> {
  const start = Date.now();
  try {
    const parsed = listInput.safeParse(params ?? {});
    if (!parsed.success) {
      return mapDomainError(
        new ValidationError("Invalid input", { issues: parsed.error.issues }),
      );
    }
    const data = await listCleanupJobs(
      { userId: ctx.userId, emailAccountId: ctx.emailAccountId },
      parsed.data,
    );
    logger.info("admin_cleanup_list_jobs", {
      durationMs: Date.now() - start,
      outcome: "ok",
      count: data.total,
    });
    return { ok: true, data };
  } catch (e) {
    return mapDomainError(e);
  }
}

export async function adminCleanupCreateJob(
  ctx: McpToolContext,
  params: unknown,
): Promise<
  McpResult<{ jobId: string }> & { dryRun?: boolean; preview?: unknown }
> {
  const start = Date.now();
  try {
    const parsed = createCleanupJobInput.safeParse(params ?? {});
    if (!parsed.success) {
      return mapDomainError(
        new ValidationError("Invalid input", { issues: parsed.error.issues }),
      );
    }
    const account = await prisma.emailAccount.findUnique({
      where: { id: ctx.emailAccountId },
      select: { account: { select: { provider: true } } },
    });
    const provider = account?.account?.provider ?? "google";

    const result = await createCleanupJob(
      {
        userId: ctx.userId,
        emailAccountId: ctx.emailAccountId,
        provider,
        logger,
      },
      parsed.data,
    );
    logger.info("admin_cleanup_create_job", {
      dryRun: result.dryRun,
      durationMs: Date.now() - start,
      outcome: "ok",
    });
    if (result.dryRun) {
      return { ok: true, dryRun: true, preview: result.preview };
    }
    return { ok: true, dryRun: false, data: result.data };
  } catch (e) {
    return mapDomainError(e);
  }
}
