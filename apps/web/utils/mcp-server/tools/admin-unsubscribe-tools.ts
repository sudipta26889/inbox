import { createScopedLogger } from "@/utils/logger";
import type { McpResult } from "@/utils/mcp-server/envelope";
import { mapDomainError } from "@/utils/mcp-server/error-mapper";
import { ValidationError } from "@/utils/mcp-server/errors";
import {
  listUnsubscribeCandidates,
  listUnsubscribeCandidatesInput,
  requestUnsubscribe,
  requestUnsubscribeInput,
} from "@/utils/unsubscriber/domain";
import type { McpToolContext } from "./registry";

const logger = createScopedLogger("mcp-admin-unsubscribe");

export async function adminUnsubscribeList(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResult<Awaited<ReturnType<typeof listUnsubscribeCandidates>>>> {
  const start = Date.now();
  try {
    const parsed = listUnsubscribeCandidatesInput.safeParse(params ?? {});
    if (!parsed.success) {
      return mapDomainError(
        new ValidationError("Invalid input", { issues: parsed.error.issues }),
      );
    }
    const data = await listUnsubscribeCandidates(
      { userId: ctx.userId, emailAccountId: ctx.emailAccountId },
      parsed.data,
    );
    logger.info("admin_unsubscribe_list", {
      durationMs: Date.now() - start,
      outcome: "ok",
      count: data.total,
    });
    return { ok: true, data };
  } catch (e) {
    return mapDomainError(e);
  }
}

export async function adminUnsubscribeRequest(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResult<unknown> & { dryRun?: boolean; preview?: unknown }> {
  const start = Date.now();
  try {
    const parsed = requestUnsubscribeInput.safeParse(params ?? {});
    if (!parsed.success) {
      return mapDomainError(
        new ValidationError("Invalid input", { issues: parsed.error.issues }),
      );
    }
    const result = await requestUnsubscribe(
      { userId: ctx.userId, emailAccountId: ctx.emailAccountId, logger },
      parsed.data,
    );
    logger.info("admin_unsubscribe_request", {
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
