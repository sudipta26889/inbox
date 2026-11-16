import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { DELETE, GET } from "./route";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/middleware", () => ({
  withAuth:
    (_scope: string, handler: (request: any) => Promise<Response>) =>
    (request: any) =>
      handler(request),
}));

const routeContext = { params: Promise.resolve({}) };

function fakeRequest(url: string) {
  return { nextUrl: url, auth: { userId: "user_1" } } as any;
}

type FakeConfigRow = {
  id: string;
  clientId: string;
  taskId: string | null;
  url: string;
  enabled: boolean;
  secret: string;
  events: string[];
  createdAt: Date;
  updatedAt: Date;
};

describe("DELETE /api/user/a2a-webhooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.mcpServerClient.findUnique.mockResolvedValue({
      clientId: "client_1",
      userId: "user_1",
    } as any);
  });

  it("removes every row for the client — including a task-specific row a peer created via pushconfig.set — not just the client default", async () => {
    // Reproduces the reported kill-switch regression: the owner has a
    // default config; a peer separately creates a task-specific config
    // through the A2A pushconfig.set method (push-config.ts). Before this
    // fix, DELETE only matched `{ clientId, taskId: null }`, so the
    // task-specific row survived and kept delivering even after this
    // returned `{ success: true }`.
    let rows: FakeConfigRow[] = [
      {
        id: "cfg_default",
        clientId: "client_1",
        taskId: null,
        url: "https://old.example/hook",
        enabled: true,
        secret: "s1",
        events: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "cfg_task",
        clientId: "client_1",
        taskId: "task_1",
        url: "https://peer.example/hook",
        enabled: true,
        secret: "s2",
        events: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    // Keyed on the actual where-clause arguments (not call order): a
    // deleteMany that still filters on taskId: null would leave cfg_task in
    // `rows`, which is exactly the bug this test needs to catch.
    prisma.a2aWebhookConfig.deleteMany.mockImplementation(({ where }: any) => {
      const before = rows.length;
      rows = rows.filter(
        (row) =>
          !(
            row.clientId === where.clientId &&
            (!("taskId" in where) || row.taskId === where.taskId)
          ),
      );
      return Promise.resolve({ count: before - rows.length }) as any;
    });
    prisma.a2aWebhookConfig.findFirst.mockImplementation(({ where }: any) => {
      const match = rows.find(
        (row) =>
          row.clientId === where.clientId &&
          (!("taskId" in where) || row.taskId === where.taskId),
      );
      return Promise.resolve(match ?? null) as any;
    });

    const deleteResponse = await DELETE(
      fakeRequest(
        "https://example.com/api/user/a2a-webhooks?clientId=client_1",
      ),
      routeContext,
    );

    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({ success: true });
    expect(rows).toHaveLength(0);

    const getResponse = await GET(
      fakeRequest(
        "https://example.com/api/user/a2a-webhooks?clientId=client_1",
      ),
      routeContext,
    );
    const body = await getResponse.json();

    // configured: false must mean nothing is left that would still deliver —
    // not just that the default row is gone.
    expect(body.configured).toBe(false);
  });

  it("404s when there is nothing to delete for the client", async () => {
    prisma.a2aWebhookConfig.deleteMany.mockResolvedValue({ count: 0 });

    const response = await DELETE(
      fakeRequest(
        "https://example.com/api/user/a2a-webhooks?clientId=client_1",
      ),
      routeContext,
    );

    expect(response.status).toBe(404);
  });
});

describe("GET /api/user/a2a-webhooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.mcpServerClient.findUnique.mockResolvedValue({
      clientId: "client_1",
      userId: "user_1",
    } as any);
  });

  it("reports configured: true when a task-specific row delivers even with no client default", async () => {
    // A peer can create a task-specific row via pushconfig.set (A2A §3.1.7)
    // without ever creating the client-level default this route otherwise
    // reads. Before this fix, GET derived `configured` from the default row
    // alone, so it reported `false` while queueWebhook was still delivering.
    prisma.a2aWebhookConfig.findFirst.mockResolvedValue(null);
    prisma.a2aWebhookConfig.count.mockResolvedValue(1);

    const response = await GET(
      fakeRequest(
        "https://example.com/api/user/a2a-webhooks?clientId=client_1",
      ),
      routeContext,
    );
    const body = await response.json();

    expect(body.configured).toBe(true);
    expect(prisma.a2aWebhookConfig.count).toHaveBeenCalledWith({
      where: { clientId: "client_1" },
    });
  });
});
