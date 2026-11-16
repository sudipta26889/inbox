import type {
  TransactionalEmailMessage,
  TransactionalEmailSendOptions,
  TransactionalEmailProviderResult,
} from "./provider";
import { createResendTransactionalEmailProvider } from "./providers/resend";
import { assertDeliverableRecipient } from "./reserved-recipients";

const provider = process.env.RESEND_API_KEY
  ? createResendTransactionalEmailProvider(process.env.RESEND_API_KEY)
  : null;

export function isTransactionalEmailConfigured() {
  return provider !== null;
}

export async function deliverTransactionalEmail(
  message: TransactionalEmailMessage,
  options?: TransactionalEmailSendOptions,
): Promise<TransactionalEmailProviderResult | null> {
  if (!provider) return null;

  // ponytail: single chokepoint — every transactional sender funnels through
  // here, so one assert covers all of them. Test sends go to Resend's sink.
  if (!options?.test) assertDeliverableRecipient(message.to);

  return provider.send(message, options);
}
