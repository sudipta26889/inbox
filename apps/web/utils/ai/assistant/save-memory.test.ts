import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    chatMemory: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/utils/prisma", () => ({ default: mockPrisma }));

import { createScopedLogger } from "@/utils/logger";
import { saveMemory } from "./save-memory";

const logger = createScopedLogger("save-memory-test");
const base = { emailAccountId: "acct-1", logger };

/** Capture what the transaction was asked to do, without a real database. */
function captureTransaction() {
  const calls: { retired: string[]; created: Record<string, unknown> } = {
    retired: [],
    created: {},
  };

  mockPrisma.chatMemory.updateMany.mockImplementation((args) => {
    calls.retired = args.where.id?.in ?? [];
    return args;
  });
  mockPrisma.chatMemory.create.mockImplementation((args) => {
    calls.created = args.data;
    return args;
  });
  mockPrisma.$transaction.mockResolvedValue([
    { count: calls.retired.length },
    { id: "new-id" },
  ]);

  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.chatMemory.findFirst.mockResolvedValue(null);
  mockPrisma.chatMemory.findMany.mockResolvedValue([]);
  mockPrisma.chatMemory.update.mockResolvedValue({});
});

describe("saveMemory", () => {
  it("retires the live fact occupying the same subject", async () => {
    const calls = captureTransaction();
    mockPrisma.chatMemory.findMany.mockResolvedValue([
      {
        id: "old-1",
        validFrom: new Date("2026-01-01"),
        source: "AGENT_INFERRED",
      },
    ]);

    const result = await saveMemory({
      ...base,
      content: "digest at 7am",
      subject: "digest.schedule",
    });

    expect(calls.retired).toEqual(["old-1"]);
    expect(result.supersededCount).toBe(1);
    expect(calls.created.supersededAt).toBeNull();
  });

  // Without a subject there is no slot, so nothing can be mutually exclusive.
  it("retires nothing when the fact claims no subject", async () => {
    const calls = captureTransaction();

    await saveMemory({ ...base, content: "likes short replies" });

    expect(mockPrisma.chatMemory.findMany).not.toHaveBeenCalled();
    expect(calls.retired).toEqual([]);
  });

  /**
   * Late-arriving old news must not overwrite newer knowledge. A memory
   * describing an older state than the stored one is born superseded — kept for
   * history, absent from recall.
   */
  it("does not let an older fact overwrite a newer one", async () => {
    const calls = captureTransaction();
    mockPrisma.chatMemory.findMany.mockResolvedValue([
      {
        id: "newer",
        validFrom: new Date("2026-06-01"),
        source: "AGENT_INFERRED",
      },
    ]);

    const result = await saveMemory({
      ...base,
      content: "digest at 5am",
      subject: "digest.schedule",
      validFrom: new Date("2026-01-01"),
    });

    expect(calls.retired).toEqual([]);
    expect(result.bornSuperseded).toBe(true);
    expect(calls.created.supersededAt).toBeInstanceOf(Date);
  });

  /** The assistant's inference may not quietly undo what the user said. */
  it("does not let an inference override something the user stated", async () => {
    const calls = captureTransaction();
    mockPrisma.chatMemory.findMany.mockResolvedValue([
      {
        id: "stated",
        validFrom: new Date("2026-01-01"),
        source: "USER_STATED",
      },
    ]);

    const result = await saveMemory({
      ...base,
      content: "probably wants 9am",
      subject: "digest.schedule",
      source: "AGENT_INFERRED",
    });

    expect(calls.retired).toEqual([]);
    expect(result.bornSuperseded).toBe(true);
  });

  it("lets the user override their own earlier statement", async () => {
    const calls = captureTransaction();
    mockPrisma.chatMemory.findMany.mockResolvedValue([
      {
        id: "stated",
        validFrom: new Date("2026-01-01"),
        source: "USER_STATED",
      },
    ]);

    const result = await saveMemory({
      ...base,
      content: "actually 6am",
      subject: "digest.schedule",
      source: "USER_STATED",
    });

    expect(calls.retired).toEqual(["stated"]);
    expect(result.bornSuperseded).toBe(false);
  });

  // Dedupe must only consider live rows, or a retired fact blocks its own revival.
  it("deduplicates against live memories only", async () => {
    mockPrisma.chatMemory.findFirst.mockResolvedValue({ id: "dupe" });

    const result = await saveMemory({ ...base, content: "same thing" });

    expect(mockPrisma.chatMemory.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ supersededAt: null }),
      }),
    );
    expect(result).toMatchObject({ saved: false, deduplicated: true });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  /**
   * Retiring the old row and writing the new one must not half-happen: a crash
   * between them leaves two live rows in one slot, which is the bug this exists
   * to prevent.
   */
  it("retires and writes atomically", async () => {
    captureTransaction();
    mockPrisma.chatMemory.findMany.mockResolvedValue([
      {
        id: "old-1",
        validFrom: new Date("2026-01-01"),
        source: "AGENT_INFERRED",
      },
    ]);

    await saveMemory({
      ...base,
      content: "new",
      subject: "digest.schedule",
    });

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$transaction.mock.calls[0][0]).toHaveLength(2);
  });
});
