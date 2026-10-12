import { afterEach, describe, expect, it, vi } from "vitest";
import { getEmailAccount } from "@/__tests__/helpers";
import type { EmailForLLM } from "@/utils/types";
import { decideColdEmail } from "./cold-email";
import { DecisionUncertainError } from "./decision-model";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/usage", () => ({ saveAiUsage: vi.fn() }));
vi.mock("@/env", () => ({ env: {} }));

const config = {
  provider: "litellm" as const,
  modelId: "typesafe/jev-latest",
  url: "http://nuc.lan:4000/v1/systemone",
  apiKey: "sk-gateway",
};

const email: EmailForLLM = {
  id: "m1",
  from: "rep@vendor.example",
  to: "owner@company.example",
  subject: "Quick question about your Q4 goals",
  content: "I help founders book 20 demos a month. Open to a call?",
};

describe("decideColdEmail", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("marks cold at or above the cold threshold", async () => {
    stubJev(0.9);
    await expect(decide()).resolves.toMatchObject({ coldEmail: true });
  });

  it("marks not cold at or below the not-cold threshold", async () => {
    stubJev(0.1);
    await expect(decide()).resolves.toMatchObject({ coldEmail: false });
  });

  it("refuses to decide inside the uncertain band", async () => {
    stubJev(0.5);
    await expect(decide()).rejects.toBeInstanceOf(DecisionUncertainError);
  });

  it("sends the yes/no question to the API as a noul", async () => {
    const fetchMock = stubJev(0.9);
    await decide();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("typesafe/jev-latest");
    expect(body.questions.cold_email.type).toBe("noul");
  });

  it("does not leak the email into the error when the API fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("boom", { status: 500 })),
    );

    const error = await decide().catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Decision request failed with status 500",
    );
  });
});

function decide() {
  return decideColdEmail({
    config,
    email,
    emailAccount: getEmailAccount(),
    coldEmailPrompt: null,
  });
}

function stubJev(probability: number) {
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      model: "jev-1.13.0",
      answers: { cold_email: { type: "noul", noul: probability } },
      usage: { input_tokens: 400, output_tokens: 20 },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
