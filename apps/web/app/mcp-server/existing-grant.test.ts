import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { MCP_RESOURCE } from "@/utils/mcp-server/constants";
import {
  createJwtToken,
  type McpTokenPayload,
} from "@/utils/mcp-server/tokens";
import { POST as mcpPost } from "./route";
import { POST as tokenPost } from "./token/route";

const SECRET = "test-auth-secret";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
const { sendEmailWithHtml } = vi.hoisted(() => ({
  sendEmailWithHtml: vi.fn(),
}));
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi.fn(async () => ({ sendEmailWithHtml })),
}));
vi.mock("@/env", () => ({
  env: {
    AUTH_SECRET: "test-auth-secret",
    NEXT_PUBLIC_BASE_URL: "https://inbox.sudiptadhara.in",
  },
}));

type TokenRow = {
  id: string;
  accessToken: string;
  refreshToken: string | null;
  grantId: string | null;
  revoked: boolean;
  revokedReason: string | null;
  revokedAt: Date | null;
  scope: string;
  userId: string;
  emailAccountId: string;
  clientId: string;
};

// A grant as production stores it today: an access/refresh JWT pair signed
// with AUTH_SECRET, the row keyed by their jti values, with a grantId.
// The first call cold-loads the tool modules (dynamic imports in the registry),
// which can take over 5s on a busy shared machine.
describe("a token pair issued before the re-fork", { timeout: 30_000 }, () => {
  let rows: TokenRow[];

  beforeEach(() => {
    vi.clearAllMocks();
    rows = [
      {
        id: "row-1",
        accessToken: "jti-access-1",
        refreshToken: "jti-refresh-1",
        grantId: "grant-1",
        revoked: false,
        revokedReason: null,
        revokedAt: null,
        scope: "email:read email:draft",
        userId: "user-1",
        emailAccountId: "acct-1",
        clientId: "client-1",
      },
    ];
    wireTokenTable(() => rows);

    prisma.mcpServerClient.findUnique.mockResolvedValue({
      id: "c-1",
      clientId: "client-1",
      type: "MCP",
    } as never);
    prisma.user.findUnique.mockResolvedValue({
      email: "me@example.com",
    } as never);
    prisma.emailAccount.findFirst.mockResolvedValue({
      id: "acct-1",
      userId: "user-1",
    } as never);
    prisma.emailAccount.findMany.mockResolvedValue([
      {
        id: "acct-1",
        email: "me@example.com",
        account: { provider: "google" },
      },
    ] as never);
  });

  it("calls a tool with the existing access token", async () => {
    const response = await callTool(token("access", "jti-access-1"));

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.result.isError).toBeUndefined();
    expect(payload.result.content[0].text).toContain("me@example.com");
  });

  it("refreshes, keeps the grant, and the new access token calls a tool", async () => {
    const response = await tokenPost(
      form({
        grant_type: "refresh_token",
        client_id: "client-1",
        refresh_token: token("refresh", "jti-refresh-1"),
      }),
    );

    expect(response.status).toBe(200);
    const tokens = await response.json();
    expect(tokens).toMatchObject({ token_type: "Bearer" });
    expect(tokens.refresh_token).toEqual(expect.any(String));

    expect(rows[0]).toMatchObject({ revoked: true, revokedReason: "rotated" });
    expect(rows[1]).toMatchObject({
      grantId: "grant-1",
      scope: "email:read email:draft",
      clientId: "client-1",
      emailAccountId: "acct-1",
      revoked: false,
    });

    expect((await callTool(tokens.access_token)).status).toBe(200);
    // The rotated pair no longer works.
    expect((await callTool(token("access", "jti-access-1"))).status).toBe(401);
  });

  it("returns an approval refusal on send_email to the client as a tool error", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      id: "acct-1",
      email: "me@example.com",
      account: { provider: "google" },
    } as never);
    sendEmailWithHtml.mockRejectedValue(
      new Error("The send was not approved."),
    );

    const response = await callTool(
      token("access", "jti-access-1", "email:read email:write"),
      "send_email",
      { to: ["a@example.com"], subject: "Hi", body: "x" },
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.result.isError).toBe(true);
    expect(payload.result.content[0].text).toContain(
      "The send was not approved.",
    );
    expect(sendEmailWithHtml).toHaveBeenCalledTimes(1);
  });

  function wireTokenTable(table: () => TokenRow[]) {
    prisma.mcpServerAccessToken.findFirst.mockImplementation(
      (async ({ where }: { where: Partial<TokenRow> }) =>
        table().find((row) =>
          Object.entries(where).every(
            ([key, value]) => row[key as keyof TokenRow] === value,
          ),
        ) ?? null) as never,
    );
    prisma.mcpServerAccessToken.update.mockResolvedValue({} as never);
    prisma.mcpServerAccessToken.updateMany.mockImplementation((async ({
      where,
      data,
    }: {
      where: Partial<TokenRow>;
      data: Partial<TokenRow>;
    }) => {
      const matched = table().filter((row) =>
        Object.entries(where).every(
          ([key, value]) => row[key as keyof TokenRow] === value,
        ),
      );
      for (const row of matched) Object.assign(row, data);
      return { count: matched.length };
    }) as never);
    prisma.mcpServerAccessToken.create.mockImplementation((async ({
      data,
    }: {
      data: TokenRow;
    }) => {
      const row = {
        ...data,
        id: `row-${table().length + 1}`,
        revoked: false,
        revokedReason: null,
        revokedAt: null,
      };
      table().push(row);
      return row;
    }) as never);
  }
});

function token(
  type: "access" | "refresh",
  jti: string,
  scope = "email:read email:draft",
) {
  const now = Math.floor(Date.now() / 1000);
  const payload: McpTokenPayload = {
    aud: MCP_RESOURCE,
    sub: "user-1",
    email: "me@example.com",
    email_account_id: "acct-1",
    scope,
    client_id: "client-1",
    iat: now - 60,
    exp: now + 3600,
    jti,
    token_type: type,
  };
  return createJwtToken(payload, SECRET);
}

function callTool(
  accessToken: string,
  name = "list_email_accounts",
  args: Record<string, unknown> = {},
) {
  return mcpPost(
    new NextRequest("https://inbox.sudiptadhara.in/mcp-server", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    { params: Promise.resolve({}) },
  );
}

function form(fields: Record<string, string>) {
  return new NextRequest("https://inbox.sudiptadhara.in/mcp-server/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}
