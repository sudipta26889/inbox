import { encryptToken } from "@/utils/encryption";
import { createScopedLogger } from "@/utils/logger";
import { NotFoundError } from "@/utils/mcp-server/errors";
import prisma from "@/utils/prisma";
import { z } from "zod";

const logger = createScopedLogger("account-domain");

/**
 * Fields exposed by the admin_account_* MCP tools.
 *
 * The select clause is the primary defense for the security guarantee in
 * Plan 09: credential / auth / billing / AI-model / subsystem-owned fields
 * are NEVER requested from Prisma, so they cannot leak into the response.
 */
const profileSelect = {
  id: true,
  email: true,
  createdAt: true,
  updatedAt: true,
  image: true,
  name: true,
  about: true,
  signature: true,
  timezone: true,
  calendarBookingLink: true,
  role: true,
} as const;

export type AccountProfile = Awaited<ReturnType<typeof getAccountProfile>>;

export async function getAccountProfile(ctx: {
  userId: string;
  emailAccountId: string;
}) {
  const row = await prisma.emailAccount.findFirst({
    where: { id: ctx.emailAccountId, userId: ctx.userId },
    select: {
      ...profileSelect,
      user: {
        select: {
          taskpilotApiKey: true,
          taskpilotWorkspaceSlug: true,
        },
      },
    },
  });
  if (!row) {
    logger.warn("getAccountProfile: account not found", {
      emailAccountId: ctx.emailAccountId,
    });
    throw new NotFoundError("Email account not found");
  }
  const { user, ...profile } = row;
  return {
    ...profile,
    taskpilot: {
      configured: Boolean(
        user?.taskpilotApiKey && user?.taskpilotWorkspaceSlug,
      ),
      workspaceSlug: user?.taskpilotWorkspaceSlug ?? null,
    },
  };
}

/**
 * IANA timezone allowlist. Built once at module load from Node's built-in
 * `Intl.supportedValuesOf("timeZone")`. When the runtime lacks this (very old
 * Node), `VALID_TIMEZONES` is empty and the schema falls back to permissive
 * validation — production Node 20+ always exposes it.
 */
const VALID_TIMEZONES = new Set<string>(
  (
    Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
  ).supportedValuesOf?.("timeZone") ?? [],
);

const trimmedNullable = (max: number) =>
  z
    .string()
    .max(max)
    .transform((v) => v.trim())
    .transform((v) => (v.length === 0 ? null : v))
    .nullable();

export const updateAccountProfileSchema = z
  .object({
    name: trimmedNullable(200).optional(),
    about: trimmedNullable(2000).optional(),
    signature: trimmedNullable(20_000).optional(),
    role: trimmedNullable(100).optional(),
    timezone: z
      .string()
      .nullable()
      .optional()
      .refine(
        (v) =>
          v == null ||
          v === "" ||
          VALID_TIMEZONES.size === 0 ||
          VALID_TIMEZONES.has(v),
        { message: "Unknown IANA timezone" },
      ),
    calendarBookingLink: z
      .string()
      .url()
      .startsWith("http", { message: "Must be an http(s) URL" })
      .nullable()
      .optional(),
    taskpilotApiKey: z.string().min(1).nullable().optional(),
    taskpilotWorkspaceSlug: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9-]+$/i)
      .nullable()
      .optional(),
  })
  .strict()
  .refine((obj) => Object.keys(obj).length > 0, {
    message: "At least one field is required",
  })
  .superRefine((data, ctx) => {
    const keyTouched = Object.hasOwn(data, "taskpilotApiKey");
    const slugTouched = Object.hasOwn(data, "taskpilotWorkspaceSlug");
    if (keyTouched !== slugTouched) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "taskpilotApiKey and taskpilotWorkspaceSlug must be set or cleared together",
        path: ["taskpilotApiKey"],
      });
    }
  });

export type UpdateAccountProfileInput = z.infer<
  typeof updateAccountProfileSchema
>;

export async function updateAccountProfile(
  ctx: { userId: string; emailAccountId: string },
  input: UpdateAccountProfileInput,
) {
  const owned = await prisma.emailAccount.findFirst({
    where: { id: ctx.emailAccountId, userId: ctx.userId },
    select: { id: true },
  });
  if (!owned) {
    logger.warn("updateAccountProfile: account not found", {
      emailAccountId: ctx.emailAccountId,
    });
    throw new NotFoundError("Email account not found");
  }

  const { taskpilotApiKey, taskpilotWorkspaceSlug, ...emailAccountData } =
    input;
  const taskpilotTouched =
    Object.hasOwn(input, "taskpilotApiKey") ||
    Object.hasOwn(input, "taskpilotWorkspaceSlug");

  if (Object.keys(emailAccountData).length > 0) {
    await prisma.emailAccount.update({
      where: { id: ctx.emailAccountId },
      data: emailAccountData,
    });
  }

  if (taskpilotTouched) {
    await prisma.user.update({
      where: { id: ctx.userId },
      data: {
        taskpilotApiKey:
          taskpilotApiKey === null ? null : encryptToken(taskpilotApiKey),
        taskpilotWorkspaceSlug: taskpilotWorkspaceSlug ?? null,
      },
    });
  }

  logger.info("Account profile updated", {
    emailAccountId: ctx.emailAccountId,
    fields: Object.keys(input),
  });

  return getAccountProfile(ctx);
}
