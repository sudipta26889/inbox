import { NextResponse } from "next/server";
import { withAccountApiKey } from "@/utils/api-middleware";
import { createEmailProvider } from "@/utils/email/provider";
import { SafeError } from "@/utils/error";
import { emailsQuerySchema } from "@/app/api/v1/emails/validation";
import { resolveUserAccount } from "@/app/api/v1/emails/resolve-account";
import type { ParsedMessage } from "@/utils/types";

export const GET = withAccountApiKey("v1/emails", [], async (request) => {
  const { userId } = request.apiAuth;
  const { searchParams } = new URL(request.url);

  const parsed = emailsQuerySchema.safeParse({
    account: searchParams.get("account") ?? undefined,
    query: searchParams.get("query") ?? undefined,
    limit: searchParams.get("limit") ?? undefined,
    cursor: searchParams.get("cursor") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid query parameters" },
      { status: 400 },
    );
  }
  const { account, query, limit, cursor } = parsed.data;

  const resolved = await resolveUserAccount({
    userId,
    requestedAccountId: account,
  });
  if (!resolved) {
    throw new SafeError(
      "Requested account is not linked to this API key's user",
      403,
    );
  }

  const emailProvider = await createEmailProvider({
    emailAccountId: resolved.emailAccountId,
    provider: resolved.provider,
    logger: request.logger,
  });

  const { messages, nextPageToken } =
    await emailProvider.getMessagesWithPagination({
      query,
      maxResults: limit,
      pageToken: cursor,
    });

  const labelNameById = await getLabelNameMap(emailProvider);

  return NextResponse.json({
    emails: messages.map((m) => serializeListItem(m, labelNameById)),
    next_cursor: nextPageToken ?? null,
  });
});

async function getLabelNameMap(
  emailProvider: Awaited<ReturnType<typeof createEmailProvider>>,
): Promise<Map<string, string>> {
  try {
    const labels = await emailProvider.getLabels();
    return new Map(labels.map((l) => [l.id, l.name]));
  } catch {
    return new Map();
  }
}

function serializeListItem(
  message: ParsedMessage,
  labelNameById: Map<string, string>,
) {
  return {
    id: message.id,
    thread_id: message.threadId,
    from: message.headers.from ?? "",
    subject: message.headers.subject ?? "",
    snippet: message.snippet ?? "",
    labels: resolveLabels(message.labelIds, labelNameById),
    received_at: toIsoDate(message.internalDate, message.headers.date),
  };
}

function resolveLabels(
  labelIds: string[] | undefined,
  labelNameById: Map<string, string>,
): string[] {
  if (!labelIds?.length) return [];
  return labelIds.map((id) => labelNameById.get(id) ?? id);
}

function toIsoDate(
  internalDate: string | null | undefined,
  headerDate: string | undefined,
): string {
  if (internalDate) {
    const ms = Number(internalDate);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  if (headerDate) {
    const parsed = new Date(headerDate);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date(0).toISOString();
}
