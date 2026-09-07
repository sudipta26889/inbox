import { env } from "@/env";
import { createScopedLogger } from "@/utils/logger";
import { SafeError } from "@/utils/error";
import prisma from "@/utils/prisma";
import { sleep } from "@/utils/sleep";
import { isMqttConfigured, publishMqtt } from "@/utils/mqtt/client";
import { publishUrgent } from "@/utils/mqtt/events";
import { isOwnerEmailAccount, notifyOwner } from "@/utils/ntfy";
import type { ExecutedRule } from "@/generated/prisma/client";

const logger = createScopedLogger("home-assistant");

export type HomeAssistantIntegrationType =
  | "webhook"
  | "mqtt"
  | "service_call"
  | "persistent_notification";

type EmailData = {
  threadId: string;
  messageId: string;
  subject: string;
  from: string;
  cc?: string;
  bcc?: string;
  headerMessageId: string;
  snippet?: string;
  labels?: string[];
  receivedAt?: Date;
};

type RuleData = {
  id: string;
  // ExecutedRule.ruleId is nullable in the schema; it is only forwarded into
  // the payload, so null passes through as null rather than being rejected.
  ruleId: string | null;
  ruleName?: string;
};

export type HomeAssistantActionConfig = {
  type: HomeAssistantIntegrationType;
  webhookId?: string;
  mqttTopic?: string;
  serviceDomain?: string;
  serviceName?: string;
  serviceData?: Record<string, any>;
  entityId?: string;
};

/**
 * Executes a Home Assistant action based on the integration type
 */
export const executeHomeAssistantAction = async (
  userId: string,
  email: EmailData,
  rule: RuleData,
  executedRule: ExecutedRule,
  config: HomeAssistantActionConfig,
) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      homeAssistantUrl: true,
      homeAssistantToken: true,
    },
  });

  // Only the REST-based branches (webhook, service_call, persistent_notification)
  // need HA credentials. mqtt talks to the broker directly, so it must not be
  // gated on a token it doesn't use.
  const requireHomeAssistantCredentials = () => {
    if (!user?.homeAssistantUrl || !user?.homeAssistantToken) {
      throw new SafeError(
        "Home Assistant connection not configured. Please add your Home Assistant URL and token in settings.",
      );
    }
    return {
      homeAssistantUrl: user.homeAssistantUrl,
      homeAssistantToken: user.homeAssistantToken,
    };
  };

  switch (config.type) {
    case "webhook": {
      const { homeAssistantUrl, homeAssistantToken } =
        requireHomeAssistantCredentials();
      return executeWebhookTrigger(
        homeAssistantUrl,
        homeAssistantToken,
        config.webhookId!,
        email,
        rule,
        executedRule,
      );
    }
    case "mqtt":
      if (!isMqttConfigured()) {
        throw new SafeError(
          "MQTT connection not configured. Please set MQTT_HOST, MQTT_USERNAME, and MQTT_PASSWORD.",
        );
      }
      return executeMqttPublish(config.mqttTopic!, email, rule, executedRule);
    case "service_call": {
      const { homeAssistantUrl, homeAssistantToken } =
        requireHomeAssistantCredentials();
      return executeServiceCall(
        homeAssistantUrl,
        homeAssistantToken,
        config.serviceDomain!,
        config.serviceName!,
        config.serviceData || {},
        email,
        rule,
        executedRule,
      );
    }
    case "persistent_notification": {
      const { homeAssistantUrl, homeAssistantToken } =
        requireHomeAssistantCredentials();
      return executePersistentNotification(
        homeAssistantUrl,
        homeAssistantToken,
        email,
        rule,
        executedRule,
        config.serviceData || {},
      );
    }
    default:
      throw new Error(
        `Unknown Home Assistant integration type: ${config.type}`,
      );
  }
};

/**
 * Trigger a Home Assistant webhook automation
 * This creates a simple payload that HA can consume
 */
async function executeWebhookTrigger(
  haUrl: string,
  token: string,
  webhookId: string,
  email: EmailData,
  rule: RuleData,
  executedRule: ExecutedRule,
) {
  if (!webhookId) {
    throw new SafeError("Webhook ID is required for webhook integration");
  }

  // Format payload for Home Assistant webhook (simpler than current webhook format)
  const payload = {
    from: email.from,
    subject: email.subject,
    snippet: email.snippet,
    thread_id: email.threadId,
    message_id: email.messageId,
    labels: email.labels,
    received_at: email.receivedAt?.toISOString(),
    rule_name: rule.ruleName,
    rule_id: rule.ruleId,
    automated: executedRule.automated,
    timestamp: new Date().toISOString(),
  };

  const url = `${haUrl}/api/webhook/${webhookId}`;

  try {
    await Promise.race([
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
      sleep(5000),
    ]);

    logger.info("Home Assistant webhook triggered", { webhookId });
  } catch (error) {
    logger.error("Home Assistant webhook failed", { error, webhookId });
    logger.info("Continuing after Home Assistant webhook timeout/error");
  }
}

/**
 * Publish to MQTT topic directly on the broker
 */
async function executeMqttPublish(
  topic: string,
  email: EmailData,
  rule: RuleData,
  executedRule: ExecutedRule,
) {
  if (!topic) {
    throw new SafeError("MQTT topic is required for MQTT integration");
  }

  await assertMqttTopicAllowed(topic, executedRule.emailAccountId);

  const payload = {
    from: email.from,
    subject: email.subject,
    snippet: email.snippet,
    thread_id: email.threadId,
    message_id: email.messageId,
    labels: email.labels,
    received_at: email.receivedAt?.toISOString(),
    rule_name: rule.ruleName,
    rule_id: rule.ruleId,
    automated: executedRule.automated,
    timestamp: new Date().toISOString(),
  };

  // Published directly rather than asking Home Assistant to do it. The old path
  // POSTed to /api/services/mqtt/publish, so every notification depended on HA
  // being up and on a per-user long-lived token. Same topic, same payload — only
  // the transport changed, so existing HA automations do not notice.
  publishMqtt(topic, JSON.stringify(payload));

  // The legacy topic above keeps its full payload because an operator chose it
  // for their own account. The bus is a broadcast, so it gets the consent-gated
  // version instead. The catch is load-bearing: consentFor does a database read,
  // and a database blip must not fail a rule execution.
  await publishUrgent({
    emailAccountId: executedRule.emailAccountId,
    ruleName: rule.ruleName ?? "",
    subject: email.subject,
    from: email.from,
  }).catch(() => {});

  // The bus tells Home Assistant that something urgent arrived; this tells the
  // owner's phone what it was. Gated on ADMINS because the ntfy topic is
  // instance-wide — see isOwnerEmailAccount. Unlike publishUrgent above, this
  // is never awaited: isOwnerEmailAccount is a database read and notifyOwner
  // is a fetch with its own 5s timeout, and this runs once per matched
  // email — awaiting either would add up to 5s of latency per email and
  // serialize across a backlog. The .catch is still load-bearing: nothing
  // here may throw back into a rule execution that already delivered the
  // MQTT message.
  notifyOwnerOfUrgentEmail(executedRule.emailAccountId, {
    title: rule.ruleName ?? "Urgent email",
    message: `${email.subject}\nFrom: ${email.from}`,
    priority: 4,
    tags: ["email"],
    click: `${env.NEXT_PUBLIC_BASE_URL}/mail`,
  }).catch((error) => {
    logger.warn("ntfy owner check failed", { error });
  });

  // publishMqtt is fire-and-forget and fail-soft: it may no-op, queue, or drop.
  // Delivery is reported by the client module's own connection logging, so this
  // must not claim more than "handed over".
  logger.info("MQTT notification handed to the broker client", { topic });
}

/**
 * Call a Home Assistant service
 */
async function executeServiceCall(
  haUrl: string,
  token: string,
  domain: string,
  service: string,
  serviceData: Record<string, any>,
  email: EmailData,
  rule: RuleData,
  executedRule: ExecutedRule,
) {
  if (!domain || !service) {
    throw new SafeError(
      "Service domain and name are required for service call",
    );
  }

  // Merge email data into service data for templating
  const data = {
    ...serviceData,
    // Add email context that can be used in HA templates
    _email_from: email.from,
    _email_subject: email.subject,
    _email_snippet: email.snippet,
    _rule_name: rule.ruleName,
  };

  const url = `${haUrl}/api/services/${domain}/${service}`;

  try {
    const response = await Promise.race([
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(data),
      }),
      sleep(5000),
    ]);

    if (response instanceof Response && !response.ok) {
      const errorText = await response.text();
      logger.error("Home Assistant service call failed", {
        status: response.status,
        error: errorText,
        domain,
        service,
      });
    } else {
      logger.info("Home Assistant service called", { domain, service });
    }
  } catch (error) {
    logger.error("Home Assistant service call failed", {
      error,
      domain,
      service,
    });
    logger.info("Continuing after Home Assistant service call timeout/error");
  }
}

/**
 * Create a persistent notification in Home Assistant
 */
async function executePersistentNotification(
  haUrl: string,
  token: string,
  email: EmailData,
  rule: RuleData,
  executedRule: ExecutedRule,
  customData: Record<string, any>,
) {
  const title = customData.title || `Email from ${email.from}`;
  const message =
    customData.message ||
    `**${email.subject}**\n\n${email.snippet || "No preview available"}\n\nMatched rule: ${rule.ruleName}`;

  const url = `${haUrl}/api/services/persistent_notification/create`;

  try {
    const response = await Promise.race([
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title,
          message,
          notification_id: `inbox_${email.threadId}`,
        }),
      }),
      sleep(5000),
    ]);

    if (response instanceof Response && !response.ok) {
      const errorText = await response.text();
      logger.error("Home Assistant persistent notification failed", {
        status: response.status,
        error: errorText,
      });
    } else {
      logger.info("Home Assistant persistent notification created");
    }
  } catch (error) {
    logger.error("Home Assistant persistent notification failed", { error });
    logger.info("Continuing after Home Assistant notification timeout/error");
  }
}

/**
 * This is a shared broker: one MQTT password reaches every topic, and the
 * topic string is free text — typed by any account holder in the rule UI,
 * or set by the AI assistant or an admin tool. This is the single chokepoint
 * every MQTT publish passes through, so it's where cross-tenant forgery has
 * to be refused:
 *
 * - a wildcard (+ or #) would subscribe-shaped input into a publish, letting
 *   one topic string touch a whole subtree it has no business touching
 * - `inbox/<slug>/...` is the namespace the A2A bus documents as
 *   authoritative for a tenant's own state, so only that tenant's own slug
 *   may publish there
 * - a Home Assistant discovery config (`homeassistant/.../config`) defines
 *   or deletes an entity; writing someone else's would hijack it
 *
 * Everything else — arbitrary home-automation topics like
 * `homeassistant/inbox/urgent` — is left alone; that freedom is the whole
 * point of the feature.
 */
async function assertMqttTopicAllowed(
  topic: string,
  emailAccountId: string,
): Promise<void> {
  if (topic.includes("+") || topic.includes("#")) {
    throw new SafeError("MQTT topic must not contain the + or # wildcards");
  }

  const segments = topic.split("/");

  if (segments[0] === "inbox") {
    const account = await prisma.emailAccount.findUnique({
      where: { id: emailAccountId },
      select: { mqttTopicSlug: true },
    });

    if (!account?.mqttTopicSlug || segments[1] !== account.mqttTopicSlug) {
      throw new SafeError(
        "MQTT topic under inbox/ must use this account's own topic slug",
      );
    }
  }

  if (segments[0] === "homeassistant" && segments.at(-1) === "config") {
    throw new SafeError(
      "MQTT topic must not publish a Home Assistant discovery config",
    );
  }
}

/**
 * Push an urgent-email notification to the owner's phone, gated on the
 * account actually being the operator's. Called fire-and-forget from
 * executeMqttPublish, never awaited — see the comment at that call site.
 */
async function notifyOwnerOfUrgentEmail(
  emailAccountId: string,
  notification: Parameters<typeof notifyOwner>[0],
): Promise<void> {
  if (await isOwnerEmailAccount(emailAccountId)) {
    await notifyOwner(notification);
  }
}
