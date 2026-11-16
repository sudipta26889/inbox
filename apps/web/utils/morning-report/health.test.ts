import { describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";

vi.mock("@/utils/prisma");

import { findConnectionProblems } from "./health";

describe("findConnectionProblems", () => {
  it("flags a mailbox with no refresh token even when not marked disconnected", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      {
        id: "ok",
        email: "ok@x.com",
        account: { disconnectedAt: null, refresh_token: "r" },
        calendarConnections: [{ isConnected: true, refreshToken: "c" }],
      },
      {
        id: "deca",
        email: "me@deca.com",
        account: { disconnectedAt: null, refresh_token: null },
        calendarConnections: [],
      },
      {
        id: "cal",
        email: "cal@x.com",
        account: { disconnectedAt: null, refresh_token: "r" },
        calendarConnections: [{ isConnected: true, refreshToken: null }],
      },
    ] as never);

    expect(await findConnectionProblems({ userId: "u" })).toEqual([
      { emailAccountId: "deca", email: "me@deca.com", problem: "mailbox" },
      { emailAccountId: "cal", email: "cal@x.com", problem: "calendar" },
    ]);
  });

  it("flags a calendar marked disconnected even if a token is still stored", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      {
        id: "cal",
        email: "cal@x.com",
        account: { disconnectedAt: null, refresh_token: "r" },
        calendarConnections: [{ isConnected: false, refreshToken: "c" }],
      },
    ] as never);

    expect(await findConnectionProblems({ userId: "u" })).toEqual([
      { emailAccountId: "cal", email: "cal@x.com", problem: "calendar" },
    ]);
  });
});
