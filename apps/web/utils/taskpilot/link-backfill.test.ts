import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createScopedLogger } from "@/utils/logger";
import { getEmailUrlForMessage } from "@/utils/url";
import {
  TaskpilotNotFoundError,
  TaskpilotServerError,
} from "@/utils/taskpilot/errors";
import { backfillTaskpilotLinks } from "@/utils/taskpilot/link-backfill";

const {
  redisMock,
  sleepMock,
  addLink,
  listLinks,
  getTask,
  listProjects,
  getConfig,
} = vi.hoisted(() => ({
  redisMock: { smembers: vi.fn(), sadd: vi.fn() },
  sleepMock: vi.fn(async () => undefined),
  addLink: vi.fn(),
  listLinks: vi.fn(),
  getTask: vi.fn(),
  listProjects: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/redis", () => ({ redis: redisMock }));
vi.mock("@/utils/sleep", () => ({ sleep: sleepMock }));
vi.mock("@/utils/taskpilot/config", () => ({
  getTaskpilotConfigForUser: getConfig,
}));
vi.mock("@/utils/taskpilot/client", () => ({
  TaskpilotClient: class {
    addLink = addLink;
    listLinks = listLinks;
    getTask = getTask;
    listProjects = listProjects;
  },
}));

const logger = createScopedLogger("link-backfill-test");
const DONE_KEY = "taskpilot:link-backfill:done";

// What TaskPilot holds: issue id -> urls already linked.
let store: Map<string, string[]>;

describe("backfillTaskpilotLinks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store = new Map();
    redisMock.smembers.mockResolvedValue([]);
    redisMock.sadd.mockResolvedValue(1);
    getConfig.mockResolvedValue({ apiKey: "tk", workspaceSlug: "acme" });
    getTask.mockImplementation(async (_project: string, issue: string) => ({
      id: issue,
      identifier: `WEB-${issue}`,
    }));
    listProjects.mockResolvedValue([{ id: "p1", identifier: "WEB" }]);
    listLinks.mockImplementation(async (_project: string, issue: string) =>
      (store.get(issue) ?? []).map((url, i) => ({ id: `l${i}`, url })),
    );
    addLink.mockImplementation(
      async (_project: string, issue: string, input: { url: string }) => {
        store.set(issue, [...(store.get(issue) ?? []), input.url]);
      },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("adds the missing link with the create path's url and input, verifies it, and marks the row done", async () => {
    findRows(row("r1", "issue-1"));

    const result = await run();

    expect(addLink).toHaveBeenCalledWith("p1", "issue-1", {
      title: "Inbox thread",
      url: urlFor("r1"),
      metadata: {
        threadId: "thread-r1",
        emailAccountId: "acc-1",
        gmailMessageId: "msg-r1",
      },
    });
    expect(redisMock.sadd).toHaveBeenCalledWith(DONE_KEY, "r1");
    expect(result).toMatchObject({
      checked: 1,
      added: 1,
      skipped: 0,
      failed: 0,
      sample: [{ issueId: "issue-1", identifier: "WEB-issue-1" }],
    });
  });

  it("reads the rows oldest first", async () => {
    findRows();

    await run();

    expect(prisma.emailTaskLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "asc" } }),
    );
  });

  it("skips ids already in the done set without touching TaskPilot", async () => {
    redisMock.smembers.mockResolvedValue(["r1"]);
    findRows(row("r1", "issue-1"));

    const result = await run({ maxTotal: 5 });

    expect(listLinks).not.toHaveBeenCalled();
    expect(addLink).not.toHaveBeenCalled();
    expect(result.checked).toBe(0);
  });

  it("marks an item done without adding when it already has the same url", async () => {
    store.set("issue-1", [urlFor("r1")]);
    findRows(row("r1", "issue-1"));

    const result = await run();

    expect(addLink).not.toHaveBeenCalled();
    expect(redisMock.sadd).toHaveBeenCalledWith(DONE_KEY, "r1");
    expect(result).toMatchObject({ checked: 1, added: 0, skipped: 1 });
  });

  it("adds when the item has other links but not this url", async () => {
    store.set("issue-1", ["https://example.com/something-else"]);
    findRows(row("r1", "issue-1"));

    const result = await run();

    expect(addLink).toHaveBeenCalledTimes(1);
    expect(result.added).toBe(1);
  });

  it("counts verify_missing as failed and does not mark the row done", async () => {
    findRows(row("r1", "issue-1"));
    addLink.mockResolvedValue(undefined); // accepted, but never shows up

    const result = await run();

    expect(addLink).toHaveBeenCalledTimes(1);
    expect(redisMock.sadd).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      added: 0,
      failed: 1,
      failedByStatus: { verify_missing: 1 },
    });
  });

  it("counts an addLink error with its status, logs it, does not mark it done, and carries on", async () => {
    findRows(row("r1", "issue-1"), row("r2", "issue-2"));
    addLink.mockRejectedValueOnce(new TaskpilotServerError(502, "bad gateway"));

    const result = await run({ maxTotal: 5 });

    expect(result).toMatchObject({
      checked: 2,
      added: 1,
      failed: 1,
      failedByStatus: { "502": 1 },
      sample: [{ issueId: "issue-2", identifier: "WEB-issue-2" }],
    });
    expect(redisMock.sadd).toHaveBeenCalledTimes(1);
    expect(redisMock.sadd).toHaveBeenCalledWith(DONE_KEY, "r2");
    const logged = vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(logged).toContain("issue-1");
    expect(logged).toContain("502");
  });

  it("does nothing when the done set has already reached maxTotal", async () => {
    redisMock.smembers.mockResolvedValue(["old"]);
    findRows(row("r1", "issue-1"));

    const result = await run({ maxTotal: 1 });

    expect(result.checked).toBe(0);
    expect(listLinks).not.toHaveBeenCalled();
  });

  it("stops during the run once the set reaches maxTotal", async () => {
    findRows(row("r1", "issue-1"), row("r2", "issue-2"));

    const result = await run({ maxTotal: 1 });

    expect(result.checked).toBe(1);
    expect(redisMock.sadd).toHaveBeenCalledTimes(1);
    expect(addLink).toHaveBeenCalledTimes(1);
  });

  it("stops after maxPerRun items", async () => {
    findRows(row("r1", "i1"), row("r2", "i2"), row("r3", "i3"));

    const result = await run({ maxTotal: 10, maxPerRun: 2 });

    expect(result.checked).toBe(2);
    expect(addLink).toHaveBeenCalledTimes(2);
  });

  it("waits between rows, not before the first or after the last", async () => {
    findRows(row("r1", "i1"), row("r2", "i2"), row("r3", "i3"));

    await run({ maxTotal: 10, delayMs: 250 });

    expect(sleepMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledWith(250);
  });

  it("returns only the first three added issue ids as the sample", async () => {
    findRows(
      row("r1", "i1"),
      row("r2", "i2"),
      row("r3", "i3"),
      row("r4", "i4"),
    );

    const result = await run({ maxTotal: 10 });

    expect(result.added).toBe(4);
    expect(result.sample).toEqual([
      { issueId: "i1", identifier: "WEB-i1" },
      { issueId: "i2", identifier: "WEB-i2" },
      { issueId: "i3", identifier: "WEB-i3" },
    ]);
  });

  describe("one link per work item", () => {
    it("adds a single link when two rows point at the same item, and marks both rows done", async () => {
      findRows(row("r1", "issue-1"), row("r2", "issue-1"));

      const result = await run({ maxTotal: 5 });

      expect(addLink).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ checked: 1, added: 1 });
      expect(redisMock.sadd).toHaveBeenCalledWith(DONE_KEY, "r1");
      expect(redisMock.sadd).toHaveBeenCalledWith(DONE_KEY, "r2");
    });

    it("treats the same issue id in another project as another item", async () => {
      findRows(row("r1", "issue-1"), {
        ...row("r2", "issue-1"),
        projectId: "p2",
      });

      const result = await run({ maxTotal: 5 });

      expect(result.checked).toBe(2);
      expect(addLink).toHaveBeenCalledTimes(2);
    });

    it("leaves rows of an item that is already done alone", async () => {
      redisMock.smembers.mockResolvedValue(["r1", "r2"]);
      findRows(row("r1", "issue-1"), row("r2", "issue-1"));

      const result = await run({ maxTotal: 5 });

      expect(result.checked).toBe(0);
      expect(getTask).not.toHaveBeenCalled();
    });
  });

  describe("the work item is read first", () => {
    it("reads the item before listing or adding any link", async () => {
      const order: string[] = [];
      getTask.mockImplementation(async (_p: string, issue: string) => {
        order.push("getTask");
        return { id: issue, identifier: "WEB-1" };
      });
      listLinks.mockImplementation(async () => {
        order.push("listLinks");
        return [];
      });
      findRows(row("r1", "issue-1"));

      await run();

      expect(order[0]).toBe("getTask");
    });

    it("counts a 404 as missing, marks the rows done, and adds nothing", async () => {
      getTask.mockRejectedValueOnce(new TaskpilotNotFoundError("gone"));
      findRows(row("r1", "issue-1"), row("r2", "issue-1"));

      const result = await run({ maxTotal: 5 });

      expect(result).toMatchObject({
        checked: 1,
        missing: 1,
        added: 0,
        failed: 0,
      });
      expect(listLinks).not.toHaveBeenCalled();
      expect(addLink).not.toHaveBeenCalled();
      expect(redisMock.sadd).toHaveBeenCalledWith(DONE_KEY, "r1");
      expect(redisMock.sadd).toHaveBeenCalledWith(DONE_KEY, "r2");
    });

    it("counts any other getTask error as failed and does not mark it done", async () => {
      getTask.mockRejectedValueOnce(new TaskpilotServerError(500, "boom"));
      findRows(row("r1", "issue-1"));

      const result = await run();

      expect(result).toMatchObject({
        missing: 0,
        failed: 1,
        failedByStatus: { "500": 1 },
      });
      expect(redisMock.sadd).not.toHaveBeenCalled();
    });

    it("puts the identifier from the item in the sample", async () => {
      getTask.mockResolvedValue({ id: "issue-1", identifier: "INBOXEMAIL-7" });
      findRows(row("r1", "issue-1"));

      const result = await run();

      expect(result.sample).toEqual([
        { issueId: "issue-1", identifier: "INBOXEMAIL-7" },
      ]);
    });

    it("builds the identifier from the project and sequence id when the item has none", async () => {
      getTask.mockResolvedValue({
        id: "issue-1",
        identifier: "",
        sequence_id: 42,
      });
      findRows(row("r1", "issue-1"));

      const result = await run();

      expect(listProjects).toHaveBeenCalledTimes(1);
      expect(result.sample).toEqual([
        { issueId: "issue-1", identifier: "WEB-42" },
      ]);
    });
  });

  describe('a "(pending)" identifier', () => {
    it("is replaced with the real identifier on the stuck rows only", async () => {
      getTask.mockResolvedValue({ id: "issue-1", identifier: "WEB-9" });
      findRows(
        { ...row("r1", "issue-1"), taskpilotIdentifier: "(pending)" },
        { ...row("r2", "issue-1"), taskpilotIdentifier: "WEB-9" },
      );

      await run({ maxTotal: 5 });

      expect(prisma.emailTaskLink.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ["r1"] } },
        data: { taskpilotIdentifier: "WEB-9" },
      });
    });

    it("is left alone when no row is pending", async () => {
      findRows({ ...row("r1", "issue-1"), taskpilotIdentifier: "WEB-9" });

      await run();

      expect(prisma.emailTaskLink.updateMany).not.toHaveBeenCalled();
    });

    it("is left alone when the item is missing", async () => {
      getTask.mockRejectedValueOnce(new TaskpilotNotFoundError("gone"));
      findRows({ ...row("r1", "issue-1"), taskpilotIdentifier: "(pending)" });

      await run();

      expect(prisma.emailTaskLink.updateMany).not.toHaveBeenCalled();
    });

    it("does not stop the link being added if updating the column fails", async () => {
      prisma.emailTaskLink.updateMany.mockRejectedValueOnce(new Error("db"));
      findRows({ ...row("r1", "issue-1"), taskpilotIdentifier: "(pending)" });

      const result = await run();

      expect(result).toMatchObject({ added: 1, failed: 0 });
    });
  });

  it("counts a row whose TaskPilot client cannot be built as failed and moves on", async () => {
    findRows(row("r1", "issue-1"));
    getConfig.mockRejectedValue(new Error("not configured"));

    const result = await run();

    expect(result).toMatchObject({ failed: 1, added: 0 });
    expect(redisMock.sadd).not.toHaveBeenCalled();
  });
});

function findRows(...rows: unknown[]) {
  prisma.emailTaskLink.findMany.mockResolvedValue(rows as never);
}

function row(id: string, issueId: string) {
  return {
    id,
    emailAccountId: "acc-1",
    gmailMessageId: `msg-${id}`,
    threadId: `thread-${id}`,
    workspaceSlug: "acme",
    projectId: "p1",
    taskpilotIssueId: issueId,
    taskpilotIdentifier: "WEB-1",
    emailAccount: {
      email: "me@example.com",
      userId: "user-1",
      account: { provider: "google" },
    },
  };
}

// The same call every create path makes for a Gmail message.
function urlFor(id: string) {
  return getEmailUrlForMessage(
    `msg-${id}`,
    `thread-${id}`,
    "me@example.com",
    "google",
  );
}

function run(
  overrides: Partial<{
    maxPerRun: number;
    maxTotal: number;
    delayMs: number;
  }> = {},
) {
  return backfillTaskpilotLinks({
    logger,
    maxPerRun: 20,
    maxTotal: 1,
    delayMs: 0,
    ...overrides,
  });
}
