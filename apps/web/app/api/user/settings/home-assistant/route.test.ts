import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "@/utils/auth";
import prisma from "@/utils/__mocks__/prisma";
import { DELETE, POST } from "./route";

vi.mock("@/utils/auth", () => ({ auth: vi.fn() }));
vi.mock("@/utils/prisma");
vi.mock("@/utils/error.server");

describe("POST /api/user/settings/home-assistant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue({
      user: { id: "user-1" },
    } as Awaited<ReturnType<typeof auth>>);
  });

  // The saved token never reaches the browser, so a blank token on update
  // must keep the stored one rather than wipe it.
  it("keeps the saved token when the URL is unchanged", async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: "user-1",
      homeAssistantUrl: "https://ha.example",
      homeAssistantToken: "saved",
    } as never);

    const response = await save({ homeAssistantUrl: "https://ha.example" });

    expect(response.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { homeAssistantUrl: "https://ha.example" },
    });
  });

  // Otherwise a live session could point the URL at its own host and have the
  // next HA rule send the owner's saved token there.
  it("refuses a URL change without re-entering the token", async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: "user-1",
      homeAssistantUrl: "https://ha.example",
      homeAssistantToken: "saved",
    } as never);

    const response = await save({ homeAssistantUrl: "https://evil.example" });

    expect(response.status).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("requires a token when none is saved yet", async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: "user-1",
      homeAssistantToken: null,
    } as never);

    const response = await save({ homeAssistantUrl: "https://ha.example" });

    expect(response.status).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("saves a new token", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: "user-1" } as never);

    const response = await save({
      homeAssistantUrl: "https://ha.example",
      homeAssistantToken: "new",
    });

    expect(response.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        homeAssistantUrl: "https://ha.example",
        homeAssistantToken: "new",
      },
    });
  });
});

describe("DELETE /api/user/settings/home-assistant", () => {
  it("clears the URL and token", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "user-1" },
    } as Awaited<ReturnType<typeof auth>>);
    prisma.user.findUnique.mockResolvedValue({ id: "user-1" } as never);

    const response = await DELETE(
      new NextRequest("http://localhost/api/user/settings/home-assistant", {
        method: "DELETE",
      }),
      { params: Promise.resolve({}) },
    );

    expect(response.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { homeAssistantUrl: null, homeAssistantToken: null },
    });
  });
});

function save(body: Record<string, string>) {
  return POST(
    new NextRequest("http://localhost/api/user/settings/home-assistant", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
}
