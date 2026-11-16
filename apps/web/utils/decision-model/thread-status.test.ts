import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestLogger,
  getEmail,
  getEmailAccount,
} from "@/__tests__/helpers";
import { SystemType } from "@/generated/prisma/enums";

const runDecisionModelMock = vi.hoisted(() => vi.fn());
vi.mock("./decision-model", async (importActual) => ({
  ...(await importActual<typeof import("./decision-model")>()),
  runDecisionModel: runDecisionModelMock,
}));

import { decideThreadStatus } from "./thread-status";
import { DecisionUncertainError } from "./decision-model";

const config = {
  provider: "typesafe" as const,
  modelId: "jev-latest",
  model: {} as never,
};
const definitions = [
  { systemType: SystemType.TO_REPLY, instructions: "The user owes a reply." },
  {
    systemType: SystemType.AWAITING_REPLY,
    instructions: "Another participant owes a reply.",
  },
  { systemType: SystemType.ACTIONED, instructions: "No reply is pending." },
];

describe("decideThreadStatus", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a valid high-confidence status", async () => {
    runDecisionModelMock.mockResolvedValue({
      answers: {
        thread_status: {
          type: "choice",
          choice: SystemType.TO_REPLY,
          confidence: 0.97,
          probabilities: {},
        },
      },
    });

    const result = await decideThreadStatus({
      config,
      emailAccount: getEmailAccount(),
      definitions,
      threadMessages: [getEmail({ content: "Can you send the report?" })],
      userSentLastEmail: false,
      logger: createTestLogger(),
    });

    expect(result.status).toBe(SystemType.TO_REPLY);
    expect(result.rationale).toContain("97% confidence");
  });

  it("rejects a status below the 0.95 bar as uncertain, so the caller escalates", async () => {
    runDecisionModelMock.mockResolvedValue({
      answers: {
        thread_status: {
          type: "choice",
          choice: SystemType.ACTIONED,
          confidence: 0.94,
          probabilities: {},
        },
      },
    });

    await expect(
      decideThreadStatus({
        config,
        emailAccount: getEmailAccount(),
        definitions,
        threadMessages: [getEmail()],
        userSentLastEmail: false,
        logger: createTestLogger(),
      }),
    ).rejects.toBeInstanceOf(DecisionUncertainError);
  });
});
