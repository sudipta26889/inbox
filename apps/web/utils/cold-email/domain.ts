import { ActionType } from "@/generated/prisma/enums";
import { getColdEmailRule } from "@/utils/cold-email/cold-email-rule";
import prisma from "@/utils/prisma";

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
