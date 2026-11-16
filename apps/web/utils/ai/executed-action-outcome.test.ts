import { describe, expect, it } from "vitest";
import { ActionType } from "@/generated/prisma/enums";
import { getActionResultError } from "./executed-action-outcome";

describe("getActionResultError", () => {
  // A Home Assistant action reports failure as a result, not a throw; without
  // this the run history shows a missing HA connection as a success.
  it("records a failed Home Assistant action as failed", () => {
    expect(
      getActionResultError(ActionType.HOME_ASSISTANT, {
        success: false,
        errorCode: "EXECUTION_FAILED",
      }),
    ).toMatchObject({ code: "EXECUTION_FAILED" });
    expect(
      getActionResultError(ActionType.HOME_ASSISTANT, { success: false }),
    ).toMatchObject({ code: "UNKNOWN_HOME_ASSISTANT_FAILURE" });
  });

  it("ignores a successful Home Assistant action", () => {
    expect(
      getActionResultError(ActionType.HOME_ASSISTANT, { success: true }),
    ).toBeNull();
  });
});
