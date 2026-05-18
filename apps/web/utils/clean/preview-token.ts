import crypto from "node:crypto";
import { env } from "@/env";

export type PreviewTokenPayload = {
  matchedCount: number;
  generatedAt: number;
  emailAccountId: string;
};

const SECRET = env.NEXTAUTH_SECRET ?? "dev-cleanup-preview-secret";

export function signPreviewToken(payload: PreviewTokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", SECRET)
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

export function verifyPreviewToken(
  token: string,
  expectedEmailAccountId: string,
): PreviewTokenPayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expectedSig = crypto
    .createHmac("sha256", SECRET)
    .update(body)
    .digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as PreviewTokenPayload;
    if (parsed.emailAccountId !== expectedEmailAccountId) return null;
    return parsed;
  } catch {
    return null;
  }
}
