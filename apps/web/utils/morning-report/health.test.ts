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
        calendarConnections: [{ refreshToken: "c" }],
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
        calendarConnections: [{ refreshToken: null }],
      },
    ] as never);

    expect(await findConnectionProblems({ userId: "u" })).toEqual([
      { emailAccountId: "deca", email: "me@deca.com", problem: "mailbox" },
      { emailAccountId: "cal", email: "cal@x.com", problem: "calendar" },
    ]);
  });
});
