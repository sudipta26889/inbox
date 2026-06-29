import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("TaskpilotClient extensions", () => {
  const extClient = new TaskpilotClient({
    apiKey: "test-key",
    workspaceSlug: "ws",
    baseUrl: "https://api.example",
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getTask issues GET to the correct URL and unwraps the body", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "iss-1",
          identifier: "INBOXEMAIL-1",
          name: "Hi",
          description_html: "<p>x</p>",
          state: { id: "s1", name: "Todo", group: "unstarted" },
          priority: "medium",
          assignees: [],
          labels: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const task = await extClient.getTask("proj-1", "iss-1");
    expect(task.identifier).toBe("INBOXEMAIL-1");
    const callUrl = (globalThis.fetch as any).mock.calls[0][0];
    expect(callUrl).toBe(
      "https://api.example/api/v1/workspaces/ws/projects/proj-1/work-items/iss-1/",
    );
  });

  it("listComments issues GET with limit query, returns oldest-first array", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [
            {
              id: "c2",
              author_display_name: "A",
              comment_html: "<p>2</p>",
              created_at: "2026-06-02T00:00:00Z",
            },
            {
              id: "c1",
              author_display_name: "B",
              comment_html: "<p>1</p>",
              created_at: "2026-06-01T00:00:00Z",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const comments = await extClient.listComments("proj-1", "iss-1", 5);
    expect(comments).toHaveLength(2);
    expect(comments[0].id).toBe("c1"); // oldest first after sort
  });

  it("updateTask issues PATCH with the patch body", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await extClient.updateTask("proj-1", "iss-1", { priority: "urgent" });
    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[1].method).toBe("PATCH");
    expect(JSON.parse(call[1].body)).toEqual({ priority: "urgent" });
  });
});
