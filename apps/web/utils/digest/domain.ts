import prisma from "@/utils/prisma";
import { ActionType, type SystemType } from "@/generated/prisma/enums";

export type DigestAuthContext = {
  userId: string;
  emailAccountId: string;
};

export type DigestScheduleSnapshot = {
  intervalDays: number | null;
  occurrences: number | null;
  daysOfWeek: number | null;
  timeOfDay: Date | null;
  lastOccurrenceAt: Date | null;
  nextOccurrenceAt: Date | null;
};

export type DigestItem = {
  ruleId: string;
  name: string;
  systemType: SystemType | null;
  enabled: boolean;
};

export type DigestConfig = {
  enabled: boolean;
  schedule: DigestScheduleSnapshot | null;
  items: DigestItem[];
};

export async function getDigestConfig(
  ctx: DigestAuthContext,
): Promise<DigestConfig> {
  const [schedule, rules] = await Promise.all([
    prisma.schedule.findUnique({
      where: { emailAccountId: ctx.emailAccountId },
      select: {
        intervalDays: true,
        occurrences: true,
        daysOfWeek: true,
        timeOfDay: true,
        lastOccurrenceAt: true,
        nextOccurrenceAt: true,
      },
    }),
    prisma.rule.findMany({
      where: { emailAccountId: ctx.emailAccountId },
      select: {
        id: true,
        name: true,
        systemType: true,
        actions: { select: { type: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const items: DigestItem[] = rules.map((r) => ({
    ruleId: r.id,
    name: r.name,
    systemType: r.systemType,
    enabled: r.actions.some((a) => a.type === ActionType.DIGEST),
  }));

  return {
    enabled: schedule !== null,
    schedule: schedule
      ? {
          intervalDays: schedule.intervalDays,
          occurrences: schedule.occurrences,
          daysOfWeek: schedule.daysOfWeek,
          timeOfDay: schedule.timeOfDay,
          lastOccurrenceAt: schedule.lastOccurrenceAt,
          nextOccurrenceAt: schedule.nextOccurrenceAt,
        }
      : null,
    items,
  };
}
