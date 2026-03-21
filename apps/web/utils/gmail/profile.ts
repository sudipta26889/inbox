import type { gmail_v1 } from "@googleapis/gmail";
import { withGmailRetry } from "@/utils/gmail/retry";

export async function getCurrentHistoryId(
  gmail: gmail_v1.Gmail,
): Promise<string> {
  const profile = await withGmailRetry(() =>
    gmail.users.getProfile({ userId: "me" }),
  );

  const historyId = profile.data.historyId;

  if (!historyId) {
    throw new Error("No historyId found in Gmail profile");
  }

  return historyId;
}
