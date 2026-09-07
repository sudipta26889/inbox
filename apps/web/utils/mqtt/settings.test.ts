import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { updateMqttSettings } from "./settings";

vi.mock("@/utils/prisma");

const mockClearAccountTopics = vi.fn();
vi.mock("@/utils/mqtt/events", () => ({
  clearAccountTopics: (...args: unknown[]) => mockClearAccountTopics(...args),
}));

const mockIsDuplicateError = vi.fn().mockReturnValue(false);
vi.mock("@/utils/prisma-helpers", () => ({
  isDuplicateError: (...args: unknown[]) => mockIsDuplicateError(...args),
}));

const ctx = { emailAccountId: "ea_1" };

function mockPrevious(overrides: {
  mqttEnabled: boolean;
  mqttTopicSlug: string | null;
}) {
  prisma.emailAccount.findUnique.mockResolvedValue(overrides as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsDuplicateError.mockReturnValue(false);
  prisma.emailAccount.update.mockResolvedValue({
    mqttEnabled: false,
    mqttTopicSlug: null,
    mqttIncludeDetail: false,
  } as never);
});

describe("updateMqttSettings", () => {
  it("clears the OLD slug's retained topics when disabling", async () => {
    mockPrevious({ mqttEnabled: true, mqttTopicSlug: "work" });

    await updateMqttSettings(ctx, {
      mqttEnabled: false,
      mqttTopicSlug: "work",
      mqttIncludeDetail: false,
    });

    expect(mockClearAccountTopics).toHaveBeenCalledExactlyOnceWith("work");
  });

  it("clears the OLD slug's retained topics on a rename, not the new one", async () => {
    mockPrevious({ mqttEnabled: true, mqttTopicSlug: "work" });

    await updateMqttSettings(ctx, {
      mqttEnabled: true,
      mqttTopicSlug: "personal",
      mqttIncludeDetail: false,
    });

    expect(mockClearAccountTopics).toHaveBeenCalledExactlyOnceWith("work");
  });

  it("does not clear anything for an unrelated edit (same enabled state, same slug)", async () => {
    mockPrevious({ mqttEnabled: true, mqttTopicSlug: "work" });

    await updateMqttSettings(ctx, {
      mqttEnabled: true,
      mqttTopicSlug: "work",
      mqttIncludeDetail: true,
    });

    expect(mockClearAccountTopics).not.toHaveBeenCalled();
  });

  it("does not clear anything when enabling for the first time (no previous slug)", async () => {
    mockPrevious({ mqttEnabled: false, mqttTopicSlug: null });

    await updateMqttSettings(ctx, {
      mqttEnabled: true,
      mqttTopicSlug: "work",
      mqttIncludeDetail: false,
    });

    expect(mockClearAccountTopics).not.toHaveBeenCalled();
  });

  it("does not clear anything when re-enabling with the same slug it was disabled with", async () => {
    mockPrevious({ mqttEnabled: false, mqttTopicSlug: "work" });

    await updateMqttSettings(ctx, {
      mqttEnabled: true,
      mqttTopicSlug: "work",
      mqttIncludeDetail: false,
    });

    expect(mockClearAccountTopics).not.toHaveBeenCalled();
  });

  it("clears the OLD slug even while staying disabled (rename while opted out)", async () => {
    mockPrevious({ mqttEnabled: false, mqttTopicSlug: "work" });

    await updateMqttSettings(ctx, {
      mqttEnabled: false,
      mqttTopicSlug: "personal",
      mqttIncludeDetail: false,
    });

    expect(mockClearAccountTopics).toHaveBeenCalledExactlyOnceWith("work");
  });

  it("translates a unique-constraint violation into a friendly error", async () => {
    mockPrevious({ mqttEnabled: false, mqttTopicSlug: null });
    prisma.emailAccount.update.mockRejectedValue(
      new Error("unique constraint failed") as never,
    );
    mockIsDuplicateError.mockReturnValue(true);

    await expect(
      updateMqttSettings(ctx, {
        mqttEnabled: true,
        mqttTopicSlug: "taken",
        mqttIncludeDetail: false,
      }),
    ).rejects.toThrow("That name is already taken");
  });

  it("rethrows an unrelated error unchanged", async () => {
    mockPrevious({ mqttEnabled: false, mqttTopicSlug: null });
    const boom = new Error("db is on fire");
    prisma.emailAccount.update.mockRejectedValue(boom as never);
    mockIsDuplicateError.mockReturnValue(false);

    await expect(
      updateMqttSettings(ctx, {
        mqttEnabled: true,
        mqttTopicSlug: "work",
        mqttIncludeDetail: false,
      }),
    ).rejects.toThrow("db is on fire");
    expect(mockClearAccountTopics).not.toHaveBeenCalled();
  });
});
