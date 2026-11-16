import { NextResponse } from "next/server";
import { withAccountApiKey } from "@/utils/api-middleware";
import { createEmailProvider } from "@/utils/email/provider";
import { SafeError } from "@/utils/error";
import { extractEmailAddresses } from "@/utils/email";
import {
  emailDetailQuerySchema,
  emailPathParamsSchema,
} from "@/app/api/v1/emails/validation";
import { resolveUserAccount } from "@/app/api/v1/emails/resolve-account";
import type { ParsedMessage } from "@/utils/types";

export const GET = withAccountApiKey(
  "v1/emails/detail",
  [],
  async (request, { params }) => {
    const { userId } = request.apiAuth;
    const { messageId } = emailPathParamsSchema.parse(await params);

    const { searchParams } = new URL(request.url);
    const queryParsed = emailDetailQuerySchema.safeParse({
      account: searchParams.get("account") ?? undefined,
    });
    if (!queryParsed.success) {
      return NextResponse.json(
        {
          error:
            queryParsed.error.issues[0]?.message ?? "Invalid query parameters",
        },
        { status: 400 },
      );
    }

    const resolved = await resolveUserAccount({
      userId,
      requestedAccountId: queryParsed.data.account,
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

    let message: ParsedMessage;
    try {
      message = await emailProvider.getMessage(messageId);
    } catch (error) {
      if (isNotFoundError(error)) {
        return NextResponse.json({ error: "Email not found" }, { status: 404 });
      }
      throw error;
    }

    const labelNameById = await getLabelNameMap(emailProvider);

    return NextResponse.json({
      id: message.id,
      thread_id: message.threadId,
      from: message.headers.from ?? "",
      to: extractEmailAddresses(message.headers.to ?? ""),
      subject: message.headers.subject ?? "",
      snippet: message.snippet ?? "",
      labels: resolveLabels(message.labelIds, labelNameById),
      received_at: toIsoDate(message.internalDate, message.headers.date),
      body_html: message.textHtml ?? "",
      body_text: message.textPlain ?? "",
      attachments: (message.attachments ?? []).map((a) => ({
        id: a.attachmentId,
        filename: a.filename,
        mime_type: a.mimeType,
        size_bytes: a.size,
      })),
    });
  },
);

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

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybeCode = (error as { code?: unknown }).code;
  if (maybeCode === 404 || maybeCode === "404") return true;
  const maybeStatus = (error as { status?: unknown }).status;
  if (maybeStatus === 404) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /not found/i.test(message);
}
