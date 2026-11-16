import { describe, expect, it } from "vitest";
import { updateTaskpilotIntegrationBody } from "@/utils/actions/taskpilot.validation";

const UUID = "683db6a7-472b-4aa6-b7f1-c527f18579ee";

describe("updateTaskpilotIntegrationBody", () => {
  it("accepts a project id on its own, without the key or slug", () => {
    expect(
      updateTaskpilotIntegrationBody.safeParse({ projectId: UUID }).success,
    ).toBe(true);
  });

  it("lower-cases an upper-case project id before it is saved", () => {
    const parsed = updateTaskpilotIntegrationBody.parse({
      projectId: UUID.toUpperCase(),
    });

    expect(parsed.projectId).toBe(UUID);
  });

  it("accepts null to clear the pin", () => {
    expect(
      updateTaskpilotIntegrationBody.safeParse({ projectId: null }).success,
    ).toBe(true);
  });

  it.each([
    "not-a-uuid",
    "123",
    "683db6a7-472b-4aa6-b7f1",
    "<script>",
  ])("rejects %j as a project id", (projectId) => {
    expect(
      updateTaskpilotIntegrationBody.safeParse({ projectId }).success,
    ).toBe(false);
  });

  it("accepts key and slug together, with or without a pin", () => {
    const base = { apiKey: "tk", workspaceSlug: "acme" };
    expect(updateTaskpilotIntegrationBody.safeParse(base).success).toBe(true);
    expect(
      updateTaskpilotIntegrationBody.safeParse({ ...base, projectId: UUID })
        .success,
    ).toBe(true);
  });

  it("accepts clearing key and slug together", () => {
    expect(
      updateTaskpilotIntegrationBody.safeParse({
        apiKey: null,
        workspaceSlug: null,
        projectId: null,
      }).success,
    ).toBe(true);
  });

  it.each([
    [{ apiKey: "tk" }],
    [{ workspaceSlug: "acme" }],
    [{ apiKey: "tk", workspaceSlug: null }],
    [{ apiKey: null, workspaceSlug: "acme" }],
    [{ apiKey: "tk", projectId: UUID }],
  ])("keeps key and slug coupled: rejects %j", (body) => {
    expect(updateTaskpilotIntegrationBody.safeParse(body).success).toBe(false);
  });

  it("rejects an empty update", () => {
    expect(updateTaskpilotIntegrationBody.safeParse({}).success).toBe(false);
  });
});
