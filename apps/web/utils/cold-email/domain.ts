import { ActionType, SystemType } from "@/generated/prisma/enums";
import type { ColdEmailUpdateSettingsBody } from "@/utils/actions/cold-email.validation";
import { getColdEmailRule } from "@/utils/cold-email/cold-email-rule";
import prisma from "@/utils/prisma";

const DEFAULT_COLD_EMAIL_LABEL = "Cold Emails";
const DEFAULT_RULE_NAME = "Cold Email Blocker";

export type ColdEmailMode =
  | "DISABLED"
  | "LIST"
  | "LABEL"
  | "ARCHIVE_AND_LABEL"
  | "ARCHIVE_AND_READ_AND_LABEL";

export interface ColdEmailSettings {
  enabled: boolean;
  labelName: string | null;
  mode: ColdEmailMode;
  prompt: string | null;
  ruleId: string | null;
}

export async function getColdEmailSettings(ctx: {
  userId: string;
  emailAccountId: string;
}): Promise<ColdEmailSettings> {
  const rule = await getColdEmailRule(ctx.emailAccountId);

  if (!rule) {
    return {
      ruleId: null,
      enabled: false,
      mode: "DISABLED",
      prompt: null,
      labelName: null,
    };
  }

  const labelAction = rule.actions.find((a) => a.type === ActionType.LABEL);
  const hasArchive = rule.actions.some((a) => a.type === ActionType.ARCHIVE);
  const hasMarkRead = rule.actions.some((a) => a.type === ActionType.MARK_READ);

  const mode: ColdEmailMode = computeMode({
    enabled: !!rule.enabled,
    hasArchive,
    hasMarkRead,
    hasLabel: !!labelAction,
  });

  const fullRule = await prisma.rule.findUnique({
    where: { id: rule.id },
    select: { id: true, instructions: true },
  });

  return {
    ruleId: rule.id,
    enabled: !!rule.enabled,
    mode,
    prompt: fullRule?.instructions ?? null,
    labelName: labelAction?.label ?? null,
  };
}

export async function updateColdEmailSettings(
  ctx: { userId: string; emailAccountId: string },
  input: ColdEmailUpdateSettingsBody,
): Promise<ColdEmailSettings> {
  const existing = await prisma.rule.findUnique({
    where: {
      emailAccountId_systemType: {
        emailAccountId: ctx.emailAccountId,
        systemType: SystemType.COLD_EMAIL,
      },
    },
    select: { id: true, enabled: true, instructions: true },
  });

  const currentSettings = await getColdEmailSettings(ctx);
  const nextMode: ColdEmailMode =
    input.mode ?? (input.enabled === false ? "DISABLED" : currentSettings.mode);
  const nextEnabled =
    input.enabled === undefined ? nextMode !== "DISABLED" : input.enabled;
  const nextPrompt =
    input.prompt === undefined ? currentSettings.prompt : input.prompt;
  const nextLabelName =
    input.labelName ?? currentSettings.labelName ?? DEFAULT_COLD_EMAIL_LABEL;

  if (!(existing || nextEnabled)) {
    return {
      ruleId: null,
      enabled: false,
      mode: "DISABLED",
      prompt: nextPrompt,
      labelName: null,
    };
  }

  const ruleId = await ensureRuleExists({
    existingId: existing?.id ?? null,
    emailAccountId: ctx.emailAccountId,
    nextEnabled,
    nextPrompt,
  });

  if (existing) {
    await prisma.rule.update({
      where: { id: ruleId },
      data: { enabled: nextEnabled, instructions: nextPrompt },
    });
  }

  if (input.mode !== undefined || !existing) {
    await prisma.action.deleteMany({ where: { ruleId } });
    const actionRows = buildActionsForMode(nextMode, nextLabelName);
    if (actionRows.length > 0) {
      await prisma.action.createMany({
        data: actionRows.map((a) => ({ ...a, ruleId })),
      });
    }
  }

  return getColdEmailSettings(ctx);
}

async function ensureRuleExists(args: {
  existingId: string | null;
  emailAccountId: string;
  nextEnabled: boolean;
  nextPrompt: string | null;
}): Promise<string> {
  if (args.existingId) return args.existingId;
  const created = await prisma.rule.create({
    data: {
      emailAccountId: args.emailAccountId,
      name: DEFAULT_RULE_NAME,
      systemType: SystemType.COLD_EMAIL,
      enabled: args.nextEnabled,
      instructions: args.nextPrompt,
    },
    select: { id: true },
  });
  return created.id;
}

function buildActionsForMode(
  mode: ColdEmailMode,
  labelName: string,
): Array<{ type: ActionType; label?: string }> {
  switch (mode) {
    case "DISABLED":
    case "LIST":
      return [];
    case "LABEL":
      return [{ type: ActionType.LABEL, label: labelName }];
    case "ARCHIVE_AND_LABEL":
      return [
        { type: ActionType.LABEL, label: labelName },
        { type: ActionType.ARCHIVE },
      ];
    case "ARCHIVE_AND_READ_AND_LABEL":
      return [
        { type: ActionType.LABEL, label: labelName },
        { type: ActionType.ARCHIVE },
        { type: ActionType.MARK_READ },
      ];
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

function computeMode(args: {
  enabled: boolean;
  hasArchive: boolean;
  hasMarkRead: boolean;
  hasLabel: boolean;
}): ColdEmailMode {
  if (!args.enabled) return "DISABLED";
  if (args.hasArchive && args.hasMarkRead) return "ARCHIVE_AND_READ_AND_LABEL";
  if (args.hasArchive) return "ARCHIVE_AND_LABEL";
  if (args.hasLabel) return "LABEL";
  return "LIST";
}
