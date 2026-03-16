import { render } from "@react-email/render";
import { nanoid } from "nanoid";
import { transporter } from "./client";
import type { ReactElement } from "react";
import SummaryEmail, { type SummaryEmailProps } from "../emails/summary";
import DigestEmail, {
  type DigestEmailProps,
  generateDigestSubject,
} from "../emails/digest";
import InvitationEmail, {
  type InvitationEmailProps,
} from "../emails/invitation";
import ReconnectionEmail, {
  type ReconnectionEmailProps,
} from "../emails/reconnection";
import ActionRequiredEmail, {
  type ActionRequiredEmailProps,
} from "../emails/action-required";
import MeetingBriefingEmail, {
  type MeetingBriefingEmailProps,
  generateMeetingBriefingSubject,
} from "../emails/meeting-briefing";
import ColdEmailNotification, {
  type ColdEmailNotificationProps,
} from "../emails/cold-email-notification";

const SMTP_NOT_CONFIGURED_MESSAGE =
  "SMTP is not configured. You need to add SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASSWORD in your .env file for emails to work.";

const sendEmail = async ({
  from,
  to,
  subject,
  react,
  test,
  tags,
  unsubscribeToken,
  baseUrl,
}: {
  from: string;
  to: string;
  subject: string;
  react: ReactElement;
  test?: boolean;
  entityRefId?: string;
  tags?: { name: string; value: string }[];
  unsubscribeToken: string;
  baseUrl: string;
}) => {
  if (!transporter) {
    console.log(SMTP_NOT_CONFIGURED_MESSAGE);
    return Promise.resolve({ data: null, error: null });
  }

  const text = await render(react, { plainText: true });
  const html = await render(react);

  try {
    const result = await transporter.sendMail({
      from,
      to: test ? "test@example.com" : to,
      subject,
      text,
      html,
      headers: {
        "List-Unsubscribe": `<${baseUrl}/api/unsubscribe?token=${unsubscribeToken}>`,
        // From Feb 2024 Google requires this for bulk senders
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        // Prevent threading on Gmail
        "X-Entity-Ref-ID": nanoid(),
        // Add tags as custom headers (some SMTP servers support this)
        ...(tags && tags.length > 0
          ? {
              "X-Tags": tags.map((t) => `${t.name}:${t.value}`).join(", "),
            }
          : {}),
      },
    });

    return { data: { id: result.messageId }, error: null };
  } catch (error) {
    console.error("Error sending email", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Error sending email: ${errorMessage}`);
  }
};

// export const sendStatsEmail = async ({
//   to,
//   test,
//   unsubscribeToken,
//   emailProps,
// }: {
//   to: string;
//   test?: boolean;
//   unsubscribeToken: string;
//   emailProps: StatsUpdateEmailProps;
// }) => {
//   // sendEmail({
//   //   to,
//   //   subject: "Your weekly email stats",
//   //   react: <StatsUpdateEmail {...emailProps} />,
//   //   test,
//   //   tags: [
//   //     {
//   //       name: "category",
//   //       value: "stats",
//   //     },
//   //   ],
//   // });
// };

export const sendSummaryEmail = async ({
  from,
  to,
  test,
  emailProps,
}: {
  from: string;
  to: string;
  test?: boolean;
  emailProps: SummaryEmailProps;
}) => {
  return sendEmail({
    from,
    to,
    subject: "Your weekly email summary",
    react: <SummaryEmail {...emailProps} />,
    test,
    unsubscribeToken: emailProps.unsubscribeToken,
    baseUrl: emailProps.baseUrl,
    tags: [
      {
        name: "category",
        value: "activity-update",
      },
    ],
  });
};

export const sendDigestEmail = async ({
  from,
  to,
  test,
  emailProps,
}: {
  from: string;
  to: string;
  test?: boolean;
  emailProps: DigestEmailProps;
}) => {
  return sendEmail({
    from,
    to,
    subject: generateDigestSubject(emailProps),
    react: <DigestEmail {...emailProps} />,
    test,
    unsubscribeToken: emailProps.unsubscribeToken,
    baseUrl: emailProps.baseUrl,
    tags: [
      {
        name: "category",
        value: "digest",
      },
    ],
  });
};

export const sendInvitationEmail = async ({
  from,
  to,
  test,
  emailProps,
}: {
  from: string;
  to: string;
  test?: boolean;
  emailProps: InvitationEmailProps;
}) => {
  return sendEmail({
    from,
    to,
    subject: `You're invited to join ${emailProps.organizationName} on Inbox`,
    react: <InvitationEmail {...emailProps} />,
    test,
    unsubscribeToken: emailProps.unsubscribeToken,
    baseUrl: emailProps.baseUrl,
    tags: [
      {
        name: "category",
        value: "invitation",
      },
    ],
  });
};

export const sendReconnectionEmail = async ({
  from,
  to,
  test,
  emailProps,
}: {
  from: string;
  to: string;
  test?: boolean;
  emailProps: ReconnectionEmailProps;
}) => {
  return sendEmail({
    from,
    to,
    subject: `Reconnect your email account: ${emailProps.email}`,
    react: <ReconnectionEmail {...emailProps} />,
    test,
    unsubscribeToken: emailProps.unsubscribeToken,
    baseUrl: emailProps.baseUrl,
    tags: [
      {
        name: "category",
        value: "reconnection",
      },
    ],
  });
};

export const sendActionRequiredEmail = async ({
  from,
  to,
  test,
  emailProps,
}: {
  from: string;
  to: string;
  test?: boolean;
  emailProps: ActionRequiredEmailProps;
}) => {
  return sendEmail({
    from,
    to,
    subject: `Action Required: ${emailProps.errorType}`,
    react: <ActionRequiredEmail {...emailProps} />,
    test,
    unsubscribeToken: emailProps.unsubscribeToken,
    baseUrl: emailProps.baseUrl,
    tags: [
      {
        name: "category",
        value: "action-required",
      },
    ],
  });
};

export const sendMeetingBriefingEmail = async ({
  from,
  to,
  test,
  emailProps,
}: {
  from: string;
  to: string;
  test?: boolean;
  emailProps: MeetingBriefingEmailProps;
}) => {
  return sendEmail({
    from,
    to,
    subject: generateMeetingBriefingSubject(emailProps),
    react: <MeetingBriefingEmail {...emailProps} />,
    test,
    unsubscribeToken: emailProps.unsubscribeToken,
    baseUrl: emailProps.baseUrl,
    tags: [
      {
        name: "category",
        value: "meeting-briefing",
      },
    ],
  });
};

/**
 * Send a notification to a cold emailer informing them their email was filtered.
 * This is different from other emails - it goes to an external sender, not our user,
 * so it doesn't have an unsubscribe token.
 */
export const sendColdEmailNotification = async ({
  from,
  to,
  replyTo,
  subject,
  inReplyTo,
  emailProps,
}: {
  from: string;
  to: string; // The cold emailer we're notifying
  replyTo: string; // The user who received the cold email
  subject: string;
  inReplyTo?: string; // Message-ID of original email for threading
  emailProps: ColdEmailNotificationProps;
}) => {
  if (!transporter) {
    console.log(SMTP_NOT_CONFIGURED_MESSAGE);
    return { data: null, error: null };
  }

  const react = <ColdEmailNotification {...emailProps} />;
  const text = await render(react, { plainText: true });
  const html = await render(react);

  try {
    const result = await transporter.sendMail({
      from,
      to,
      replyTo,
      subject,
      text,
      html,
      // Threading headers - In-Reply-To and References make the reply appear in the same thread
      headers: {
        ...(inReplyTo
          ? { "In-Reply-To": inReplyTo, References: inReplyTo }
          : {}),
        "X-Tags": "category:cold-email-notification",
      },
    });

    return { data: { id: result.messageId }, error: null };
  } catch (error) {
    console.error("Error sending cold email notification", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    throw new Error(
      `Error sending cold email notification: ${errorMessage}`,
    );
  }
};
