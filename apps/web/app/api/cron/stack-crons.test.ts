import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { GET as scheduledActions } from "@/app/api/cron/scheduled-actions/route";
import { GET as automationJobs } from "@/app/api/cron/automation-jobs/route";
import { GET as followUpReminders } from "@/app/api/follow-up-reminders/route";
import { GET as digestAll } from "@/app/api/resend/digest/all/route";
import { GET as meetingBriefs } from "@/app/api/meeting-briefs/route";
import { GET as watchAll } from "@/app/api/watch/all/route";
import { GET as processEmails } from "@/app/api/cron/process-emails/route";

// Every cron the production stack calls must answer 2xx to the cron secret;
// deploy/stack.yml logs anything else as "cron FAILED".
const { CRON_SECRET } = vi.hoisted(() => ({ CRON_SECRET: "test-cron-secret" }));

vi.mock("server-only", () => ({}));
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();
  return { env: { ...actual.env, CRON_SECRET } };
});
// An empty database: every query finds nothing to do.
vi.mock("@/utils/prisma", () => ({
  default: new Proxy(
    {},
    {
      get: (_target, model) =>
        typeof model === "string" && model.startsWith("$")
          ? vi.fn().mockResolvedValue([])
          : new Proxy(
              {},
              {
                get: (_model, op) =>
                  vi
                    .fn()
                    .mockResolvedValue(
                      String(op).startsWith("findMany")
                        ? []
                        : String(op).endsWith("Many")
                          ? { count: 0 }
                          : String(op) === "count"
                            ? 0
                            : null,
                    ),
              },
            ),
    },
  ),
}));
vi.mock("@/utils/scheduled-email/service", () => ({
  processDueScheduledEmails: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/utils/snooze/process-due", () => ({
  processDueSnoozedThreads: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/utils/email/watch-manager", () => ({
  ensureEmailAccountsWatched: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/utils/email/notify-lapsed-watches", () => ({
  notifyLapsedWatches: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/utils/follow-up/process", () => ({
  getEligibleFollowUpReminderEmailAccountIds: vi.fn().mockResolvedValue([]),
}));

const ROUTES: Record<string, typeof processEmails> = {
  "/api/cron/scheduled-actions": scheduledActions,
  "/api/cron/automation-jobs": automationJobs,
  "/api/follow-up-reminders": followUpReminders,
  "/api/resend/digest/all": digestAll,
  "/api/meeting-briefs": meetingBriefs,
  "/api/watch/all": watchAll,
  "/api/cron/process-emails": processEmails,
};

// Routes other re-fork slices still have to land (7: A2A, 9: TaskPilot).
const NOT_YET_PORTED = [
  "/api/cron/taskpilot-janitor",
  "/api/cron/a2a-digest",
  "/api/cron/a2a-tasks",
];

const stackPaths = [
  ...readFileSync(
    join(import.meta.dirname, "../../../../../deploy/stack.yml"),
    "utf8",
  ).matchAll(/^\s+hit (\S+)$/gm),
].map((match) => match[1]);

describe("deploy/stack.yml crons", () => {
  it("covers every cron the stack calls", () => {
    expect(stackPaths.length).toBeGreaterThan(0);
    expect(
      stackPaths.filter(
        (path) => !(path in ROUTES) && !NOT_YET_PORTED.includes(path),
      ),
    ).toEqual([]);
  });

  it.each(
    Object.keys(ROUTES),
  )("%s answers 2xx to the cron secret", async (path) => {
    expect(stackPaths).toContain(path);
    const response = await ROUTES[path](
      new NextRequest(`http://web:5500${path}`, {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      { params: Promise.resolve({}) },
    );
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
  });

  it.each(Object.keys(ROUTES))("%s rejects a wrong secret", async (path) => {
    const response = await ROUTES[path](
      new NextRequest(`http://web:5500${path}`, {
        headers: { authorization: "Bearer wrong" },
      }),
      { params: Promise.resolve({}) },
    );
    expect(response.status).toBe(401);
  });
});
