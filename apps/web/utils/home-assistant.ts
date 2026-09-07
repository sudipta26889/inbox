import { createScopedLogger } from "@/utils/logger";
import { SafeError } from "@/utils/error";
import prisma from "@/utils/prisma";
import { sleep } from "@/utils/sleep";
import { publishMqtt } from "@/utils/mqtt/client";
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

  if (!user?.homeAssistantUrl || !user?.homeAssistantToken) {
    throw new SafeError(
      "Home Assistant connection not configured. Please add your Home Assistant URL and token in settings.",
    );
  }

  const { homeAssistantUrl, homeAssistantToken } = user;

  switch (config.type) {
    case "webhook":
      return executeWebhookTrigger(
        homeAssistantUrl,
        homeAssistantToken,
        config.webhookId!,
        email,
        rule,
        executedRule,
      );
    case "mqtt":
      return executeMqttPublish(config.mqttTopic!, email, rule, executedRule);
    case "service_call":
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
    case "persistent_notification":
      return executePersistentNotification(
        homeAssistantUrl,
        homeAssistantToken,
        email,
        rule,
        executedRule,
        config.serviceData || {},
      );
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
  logger.info("MQTT published", { topic });
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
