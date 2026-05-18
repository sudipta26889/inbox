import prisma from "@/utils/prisma";
import { ActionType, SystemType } from "@/generated/prisma/enums";
import {
  calculateNextScheduleDate,
  createCanonicalTimeOfDay,
} from "@/utils/schedule";
import type {
  SaveDigestScheduleBody,
  SetDigestEnabledBody,
  UpdateDigestItemsBody,
} from "@/utils/actions/settings.validation";
import type { Prisma } from "@/generated/prisma/client";

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

export async function updateDigestSchedule(
  ctx: DigestAuthContext,
  input: SaveDigestScheduleBody,
): Promise<{ schedule: DigestScheduleSnapshot }> {
  const { intervalDays, daysOfWeek, timeOfDay, occurrences } = input;

  const create: Prisma.ScheduleUpsertArgs["create"] = {
    emailAccountId: ctx.emailAccountId,
    intervalDays,
    daysOfWeek,
    timeOfDay,
    occurrences,
    lastOccurrenceAt: new Date(),
    nextOccurrenceAt: calculateNextScheduleDate({
      intervalDays,
      daysOfWeek,
      timeOfDay,
      occurrences,
      lastOccurrenceAt: null,
    }),
  };

  const { emailAccountId: _e, ...update } = create;

  const schedule = await prisma.schedule.upsert({
    where: { emailAccountId: ctx.emailAccountId },
    create,
    update,
    select: {
      intervalDays: true,
      occurrences: true,
      daysOfWeek: true,
      timeOfDay: true,
      lastOccurrenceAt: true,
      nextOccurrenceAt: true,
    },
  });

  return {
    schedule: {
      intervalDays: schedule.intervalDays,
      occurrences: schedule.occurrences,
      daysOfWeek: schedule.daysOfWeek,
      timeOfDay: schedule.timeOfDay,
      lastOccurrenceAt: schedule.lastOccurrenceAt,
      nextOccurrenceAt: schedule.nextOccurrenceAt,
    },
  };
}

export type UpdateDigestItemsResult = {
  succeeded: string[];
  failed: Array<{
    id: string;
    error: { code: "NOT_FOUND"; message: string };
  }>;
  total: number;
  successCount: number;
  failureCount: number;
};

export async function updateDigestItems(
  ctx: DigestAuthContext,
  input: UpdateDigestItemsBody,
): Promise<UpdateDigestItemsResult> {
  const entries = Object.entries(input.ruleDigestPreferences);

  const results = await Promise.all(
    entries.map(async ([ruleId, enabled]) => {
      const rule = await prisma.rule.findUnique({
        where: { id: ruleId, emailAccountId: ctx.emailAccountId },
        select: { id: true, actions: { select: { type: true } } },
      });

      if (!rule) {
        return {
          ok: false as const,
          id: ruleId,
          error: { code: "NOT_FOUND" as const, message: "Rule not found" },
        };
      }

      const hasDigestAction = rule.actions.some(
        (a) => a.type === ActionType.DIGEST,
      );

      if (enabled && !hasDigestAction) {
        await prisma.action.create({
          data: { ruleId: rule.id, type: ActionType.DIGEST },
        });
      } else if (!enabled && hasDigestAction) {
        await prisma.action.deleteMany({
          where: { ruleId: rule.id, type: ActionType.DIGEST },
        });
      }

      return { ok: true as const, id: ruleId };
    }),
  );

  const succeeded = results.filter((r) => r.ok).map((r) => r.id);
  const failed = results
    .filter((r): r is Extract<typeof r, { ok: false }> => !r.ok)
    .map(({ id, error }) => ({ id, error }));

  return {
    succeeded,
    failed,
    total: entries.length,
    successCount: succeeded.length,
    failureCount: failed.length,
  };
}

export async function setDigestEnabled(
  ctx: DigestAuthContext,
  input: SetDigestEnabledBody,
): Promise<{ enabled: boolean }> {
  if (!input.enabled) {
    await prisma.schedule.deleteMany({
      where: { emailAccountId: ctx.emailAccountId },
    });
    return { enabled: false };
  }

  // Re-enable: mirror toggleDigestAction default schedule (1 day, every day, 09:00).
  const defaultSchedule = {
    intervalDays: 1,
    occurrences: 1,
    daysOfWeek: 127,
    timeOfDay: createCanonicalTimeOfDay(9, 0),
  };

  await prisma.schedule.upsert({
    where: { emailAccountId: ctx.emailAccountId },
    create: {
      emailAccountId: ctx.emailAccountId,
      ...defaultSchedule,
      lastOccurrenceAt: new Date(),
      nextOccurrenceAt: calculateNextScheduleDate({
        ...defaultSchedule,
        lastOccurrenceAt: null,
      }),
    },
    // Empty update so re-enabling on an existing schedule doesn't clobber user-customised cadence.
    update: {},
  });

  const newsletterRule = await prisma.rule.findFirst({
    where: {
      emailAccountId: ctx.emailAccountId,
      systemType: SystemType.NEWSLETTER,
    },
    select: { id: true, actions: { select: { type: true } } },
  });

  if (
    newsletterRule &&
    !newsletterRule.actions.some((a) => a.type === ActionType.DIGEST)
  ) {
    await prisma.action.create({
      data: { ruleId: newsletterRule.id, type: ActionType.DIGEST },
    });
  }

  return { enabled: true };
}
