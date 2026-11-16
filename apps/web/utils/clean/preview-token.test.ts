import { describe, expect, it } from "vitest";
import {
  signPreviewToken,
  verifyPreviewToken,
} from "@/utils/clean/preview-token";

describe("cleanup preview-token", () => {
  it("round-trips a signed payload", () => {
    const payload = {
      matchedCount: 42,
      generatedAt: 1_700_000_000_000,
      emailAccountId: "acc_1",
    };
    const token = signPreviewToken(payload);
    const out = verifyPreviewToken(token, "acc_1");
    expect(out).toEqual(payload);
  });

  it("rejects a tampered token (signature mismatch)", () => {
    const token = signPreviewToken({
      matchedCount: 42,
      generatedAt: 1,
      emailAccountId: "acc_1",
    });
    const tampered = `${token.slice(0, -2)}xx`;
    expect(verifyPreviewToken(tampered, "acc_1")).toBeNull();
  });

  it("rejects a token bound to a different emailAccountId", () => {
    const token = signPreviewToken({
      matchedCount: 42,
      generatedAt: 1,
      emailAccountId: "acc_1",
    });
    expect(verifyPreviewToken(token, "acc_2")).toBeNull();
  });

  it("rejects a malformed token", () => {
    expect(verifyPreviewToken("not-a-token", "acc_1")).toBeNull();
    expect(verifyPreviewToken("", "acc_1")).toBeNull();
  });
});
