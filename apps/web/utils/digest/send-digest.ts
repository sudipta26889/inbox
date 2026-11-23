import { render } from "@react-email/render";
import { env } from "@/env";
import { sendDigestEmail } from "@inboxzero/transactional-email";
import DigestEmail, {
  generateDigestSubject,
  type DigestEmailProps,
} from "@inboxzero/transactional-email/emails/digest";
import {
  MessagingProvider,
  MessagingRoutePurpose,
  type MessagingRouteTargetType,
} from "@/generated/prisma/enums";
import { sendAutomationMessage } from "@/utils/automation-jobs/messaging";
import { sendNotificationEmail } from "@/utils/email/send-notification-email";
import {
  DIGEST_MAX_ITEMS_PER_RULE,
  formatDigestDate,
} from "@/utils/digest/format";
import type { Logger } from "@/utils/logger";
import {
  resolveSlackRouteDestination,
  sendDigestToSlack,
} from "@/utils/messaging/providers/slack/send";
import {
  getMessagingRoute,
  getMessagingRouteWhere,
} from "@/utils/messaging/routes";
import { isMessagingChannelOperational } from "@/utils/messaging/channel-validity";
import prisma from "@/utils/prisma";
import { DigestClaimLostError } from "@/utils/digest/claim-pending-digests";
import { SendNotApprovedError } from "@/utils/mail/send-approval";
import { buildMitraDigestText } from "@/utils/digest/mitra-digest-text";
import {
  isMitraDigestConfigured,
  sendDigestToMitra,
} from "@/utils/digest/send-digest-mitra";

type DigestItem = { from: string; subject: string; content: string };
type ItemsByRule = Record<string, DigestItem[] | undefined>;

export async function sendDigest({
  emailAccountId,
  userEmail,
  unsubscribeToken,
  date,
  ruleNames,
  itemsByRule,
  logger,
  operationId,
  beforeSend,
}: {
  emailAccountId: string;
  userEmail: string;
  unsubscribeToken: string;
  date: Date;
  ruleNames: Record<string, string>;
  itemsByRule: ItemsByRule;
  logger: Logger;
  operationId?: string;
  beforeSend?: () => Promise<void>;
}): Promise<void> {
  logger = logger.with({ emailAccountId, userEmail });

  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: {
      digestSendEmail: true,
      digestSendMitra: true,
      timezone: true,
      account: { select: { provider: true } },
    },
  });

  const sendEmail = emailAccount?.digestSendEmail ?? true;
  const wantsMitra = emailAccount?.digestSendMitra ?? false;
  const sendMitra = wantsMitra && isMitraDigestConfigured();
  if (wantsMitra && !sendMitra) {
    logger.warn(
      "Skipping digest delivery to Mitra: MITRA_OWNER_A2A_URL or MITRA_OWNER_A2A_TOKEN is not set",
    );
  }

  const channels = await prisma.messagingChannel.findMany({
    where: {
      emailAccountId,
      isConnected: true,
      ...getMessagingRouteWhere(MessagingRoutePurpose.DIGESTS),
    },
    select: {
      id: true,
      provider: true,
      isConnected: true,
      accessToken: true,
      teamId: true,
      providerUserId: true,
      routes: {
        select: { purpose: true, targetType: true, targetId: true },
      },
    },
  });

  const deliveryPromises: Promise<void>[] = [];

  if (sendEmail && emailAccount) {
    deliveryPromises.push(
      sendDigestViaEmail({
        emailAccountId,
        userEmail,
        provider: emailAccount.account.provider,
        unsubscribeToken,
        date,
        ruleNames,
        itemsByRule,
        logger,
        operationId,
        beforeSend,
      }),
    );
  }

  if (sendMitra) {
    // Not through DharaHIL: approval belongs to the email path only.
    const dateKey = formatDateKey(date, emailAccount?.timezone);
    deliveryPromises.push(
      sendDigestToMitra({
        emailAccountId,
        dateKey,
        text: buildMitraDigestText({ dateKey, ruleNames, itemsByRule }),
        logger,
      }),
    );
  }

  for (const channel of channels) {
    const route = getMessagingRoute(
      channel.routes,
      MessagingRoutePurpose.DIGESTS,
    );
    if (!route) continue;
    if (!isMessagingChannelOperational(channel)) {
      logger.warn("Skipping digest delivery for invalid messaging channel", {
        messagingChannelId: channel.id,
        provider: channel.provider,
      });
      continue;
    }

    switch (channel.provider) {
      case MessagingProvider.SLACK:
        if (!channel.accessToken) continue;
        deliveryPromises.push(
          sendDigestViaSlack({
            accessToken: channel.accessToken,
            route,
            date,
            ruleNames,
            itemsByRule,
            logger,
          }),
        );
        break;
      case MessagingProvider.TEAMS:
      case MessagingProvider.TELEGRAM:
        deliveryPromises.push(
          sendDigestViaMessagingApp({
            channel,
            route,
            date,
            ruleNames,
            itemsByRule,
            logger,
          }),
        );
        break;
    }
  }

  if (deliveryPromises.length === 0) {
    if (channels.length > 0 || (wantsMitra && !sendMitra)) {
      // Email is off and every configured channel (messaging or Mitra) was
      // skipped (non-operational or missing credentials). Throw so the caller
      // doesn't mark the digest SENT and redact its items.
      throw new Error(
        "No deliverable digest channels: email delivery is disabled and all configured messaging channels are non-operational",
      );
    }
    logger.info("No delivery channels configured, skipping digest");
    return;
  }

  const results = await Promise.allSettled(deliveryPromises);
  const failures = results.filter((r) => r.status === "rejected");

  const claimLost = failures.find(
    (f) => (f as PromiseRejectedResult).reason instanceof DigestClaimLostError,
  );
  if (claimLost) throw (claimLost as PromiseRejectedResult).reason;

  const notApproved = failures.find(
    (f) => (f as PromiseRejectedResult).reason instanceof SendNotApprovedError,
  );
  if (notApproved) throw (notApproved as PromiseRejectedResult).reason;

  if (failures.length > 0) {
    for (const failure of failures) {
      logger.error("Digest delivery channel failed", {
        reason: (failure as PromiseRejectedResult).reason,
      });
    }

    if (failures.length === results.length) {
      throw new Error("All digest delivery channels failed");
    }
  }
}

async function sendDigestViaEmail({
  emailAccountId,
  userEmail,
  provider,
  unsubscribeToken,
  date,
  ruleNames,
  itemsByRule,
  logger,
  operationId,
  beforeSend,
}: {
  emailAccountId: string;
  userEmail: string;
  provider: string;
  unsubscribeToken: string;
  date: Date;
  ruleNames: Record<string, string>;
  itemsByRule: ItemsByRule;
  logger: Logger;
  operationId?: string;
  beforeSend?: () => Promise<void>;
}) {
  const emailProps: DigestEmailProps = {
    baseUrl: env.NEXT_PUBLIC_BASE_URL,
    unsubscribeToken,
    date,
    ruleNames,
    ...itemsByRule,
    emailAccountId,
  };

  logger.info("Sending digest via email");
  await sendNotificationEmail({
    emailAccountId,
    userEmail,
    provider,
    subject: generateDigestSubject(emailProps),
    sendViaResend: () =>
      sendDigestEmail({
        from: env.RESEND_FROM_EMAIL,
        to: userEmail,
        emailProps,
      }),
    renderHtml: () => render(DigestEmail(emailProps)),
    logger,
    operationId,
    beforeSend,
  });
}

async function sendDigestViaSlack({
  accessToken,
  route,
  date,
  ruleNames,
  itemsByRule,
  logger,
}: {
  accessToken: string;
  route: { targetId: string; targetType: MessagingRouteTargetType };
  date: Date;
  ruleNames: Record<string, string>;
  itemsByRule: ItemsByRule;
  logger: Logger;
}) {
  const destination = await resolveSlackRouteDestination({
    accessToken,
    route,
  });

  if (!destination) {
    // Throw so this counts as a channel failure in Promise.allSettled;
    // otherwise a Slack-only digest could be marked SENT without actually
    // delivering.
    throw new Error("No Slack destination resolved for digest");
  }

  logger.info("Sending digest to Slack");
  await sendDigestToSlack({
    accessToken,
    channelId: destination,
    date,
    ruleNames,
    itemsByRule,
  });
  logger.info("Digest sent to Slack");
}

async function sendDigestViaMessagingApp({
  channel,
  route,
  date,
  ruleNames,
  itemsByRule,
  logger,
}: {
  channel: {
    provider: MessagingProvider;
    accessToken: string | null;
    teamId: string | null;
    providerUserId: string | null;
  };
  route: { targetId: string; targetType: MessagingRouteTargetType };
  date: Date;
  ruleNames: Record<string, string>;
  itemsByRule: ItemsByRule;
  logger: Logger;
}) {
  logger.info("Sending digest to messaging app", {
    provider: channel.provider,
  });

  await sendAutomationMessage({
    channel,
    route,
    text: formatDigestText({ date, ruleNames, itemsByRule }),
    logger,
  });

  logger.info("Digest sent to messaging app", { provider: channel.provider });
}

function formatDateKey(date: Date, timeZone?: string | null) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function formatDigestText({
  date,
  ruleNames,
  itemsByRule,
}: {
  date: Date;
  ruleNames: Record<string, string>;
  itemsByRule: ItemsByRule;
}): string {
  const sections: string[] = [
    `📋 Your Inbox digest — ${formatDigestDate(date)}`,
  ];

  for (const [ruleKey, items] of Object.entries(itemsByRule)) {
    if (!items?.length) continue;
    const displayName = ruleNames[ruleKey] ?? ruleKey;
    const visible = items.slice(0, DIGEST_MAX_ITEMS_PER_RULE);
    const overflow = items.length - visible.length;

    const lines = visible.map((item) => `- ${item.from} — ${item.subject}`);

    if (overflow > 0) lines.push(`+ ${overflow} more`);

    sections.push(`${displayName} (${items.length})\n${lines.join("\n")}`);
  }

  sections.push("Generated by Inbox");
  return sections.join("\n\n");
}
