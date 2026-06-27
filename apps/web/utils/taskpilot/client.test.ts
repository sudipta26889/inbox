import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskpilotClient } from "@/utils/taskpilot/client";
import {
  TaskpilotAuthError,
  TaskpilotServerError,
  TaskpilotValidationError,
} from "@/utils/taskpilot/errors";

const client = new TaskpilotClient({
  apiKey: "tk_test",
  workspaceSlug: "acme",
  baseUrl: "https://taskpilot.example",
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
afterEach(() => fetchMock.mockReset());

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("TaskpilotClient.listProjects", () => {
  it("returns projects from a 200 response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { id: "p1", identifier: "WEB", name: "Web", description: null },
      ]),
    );
    const projects = await client.listProjects();
    expect(projects).toEqual([
      { id: "p1", identifier: "WEB", name: "Web", description: null },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://taskpilot.example/api/v1/workspaces/acme/projects/",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Api-Key": "tk_test" }),
      }),
    );
  });

  it("throws TaskpilotAuthError on 401", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "unauthorized" }, { status: 401 }),
    );
    await expect(client.listProjects()).rejects.toBeInstanceOf(
      TaskpilotAuthError,
    );
  });

  it("throws TaskpilotRateLimitError on 429 with reset header", async () => {
    const resetUnix = Math.floor(Date.now() / 1000) + 30;
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {},
        { status: 429, headers: { "X-RateLimit-Reset": String(resetUnix) } },
      ),
    );
    await expect(client.listProjects()).rejects.toMatchObject({
      code: "TASKPILOT_RATE_LIMITED",
      resetAt: new Date(resetUnix * 1000),
    });
  });

  it("throws TaskpilotServerError on 500", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 500 }));
    await expect(client.listProjects()).rejects.toBeInstanceOf(
      TaskpilotServerError,
    );
  });
});

describe("TaskpilotClient.createWorkItem", () => {
  it("returns alreadyExisted=false on 201", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { id: "issue-1", identifier: "WEB-42", sequence_id: 42 },
        { status: 201 },
      ),
    );
    const result = await client.createWorkItem("project-uuid", {
      name: "Title",
      description_html: "<p>body</p>",
      priority: "medium",
      external_source: "inbox",
      external_id: "msg-1",
    });
    expect(result).toEqual({
      id: "issue-1",
      identifier: "WEB-42",
      sequence_id: 42,
      alreadyExisted: false,
    });
  });

  it("maps 409 to alreadyExisted=true with the existing id", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: "duplicate", id: "issue-existing" },
        { status: 409 },
      ),
    );
    const result = await client.createWorkItem("project-uuid", {
      name: "Title",
      description_html: "<p>body</p>",
      priority: "medium",
      external_source: "inbox",
      external_id: "msg-1",
    });
    expect(result.alreadyExisted).toBe(true);
    expect(result.id).toBe("issue-existing");
  });

  it("throws TaskpilotValidationError on 400", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "name is required" }, { status: 400 }),
    );
    await expect(
      client.createWorkItem("project-uuid", {
        name: "",
        description_html: "",
        priority: "medium",
        external_source: "inbox",
        external_id: "msg-1",
      }),
    ).rejects.toBeInstanceOf(TaskpilotValidationError);
  });
});
