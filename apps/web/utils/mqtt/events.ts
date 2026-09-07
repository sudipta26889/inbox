import "server-only";
import { createScopedLogger } from "@/utils/logger";
import { isMqttConfigured, publishMqtt } from "@/utils/mqtt/client";
import {
  approvalsPayload,
  digestPayload,
  discoveryConfig,
  entityTopics,
  isValidSlug,
  type MqttEntity,
  serviceDiscoveryConfig,
  type ServiceEntity,
  serviceTopics,
  unreadPayload,
  urgentPayload,
} from "@/utils/mqtt/topics";
import prisma from "@/utils/prisma";

/**
 * The things Inbox tells the bus.
 *
 * The four per-account publishers resolve opt-in first and build nothing
 * otherwise, so an account that never enabled the bus cannot leak through a
 * publisher added later. The service publisher below carries no per-account
 * identity, so it needs no such check.
 */

const logger = createScopedLogger("mqtt-events");

const ENTITY_META: Record<MqttEntity, { name: string; icon: string }> = {
  unread: { name: "Unread", icon: "mdi:email" },
  urgent: { name: "Last urgent mail", icon: "mdi:alert" },
  digest: { name: "Digest", icon: "mdi:newspaper" },
  approvals: { name: "Pending approvals", icon: "mdi:account-check" },
};

const SERVICE_ENTITY_META: Record<
  ServiceEntity,
  { name: string; icon: string }
> = {
  dependencies: { name: "Dependencies", icon: "mdi:server-network" },
  peers: { name: "Peer credentials", icon: "mdi:key-alert" },
  agent_runs: { name: "Agent runs", icon: "mdi:robot" },
};

type Consent = { slug: string; includeDetail: boolean };

export async function publishUnread({
  emailAccountId,
  unread,
  total,
}: {
  emailAccountId: string;
  unread: number;
  total: number;
}): Promise<void> {
  const consent = await consentFor(emailAccountId);
  if (!consent) return;

  publishEntity(consent.slug, "unread", unreadPayload({ unread, total }));
}

export async function publishUrgent({
  emailAccountId,
  ruleName,
  subject,
  from,
}: {
  emailAccountId: string;
  ruleName: string;
  subject: string;
  from: string;
}): Promise<void> {
  const consent = await consentFor(emailAccountId);
  if (!consent) return;

  publishEntity(
    consent.slug,
    "urgent",
    urgentPayload({
      ruleName,
      // No structured per-day count exists in this pipeline — see
      // digestPayload's `items` for the same precedent. Omitting the key
      // beats publishing a plausible-looking but false "1" every time.
      at: new Date().toISOString(),
      ...(consent.includeDetail ? { detail: { subject, from } } : {}),
    }),
  );
}

export async function publishDigest({
  emailAccountId,
  items,
}: {
  emailAccountId: string;
  /** Omitted when no real item count exists — see digestPayload. */
  items?: number;
}): Promise<void> {
  const consent = await consentFor(emailAccountId);
  if (!consent) return;

  publishEntity(
    consent.slug,
    "digest",
    digestPayload({ items, at: new Date().toISOString() }),
  );
}

export async function publishApprovals({
  emailAccountId,
  pending,
  oldestWaitingSeconds,
  actions,
}: {
  emailAccountId: string;
  pending: number;
  oldestWaitingSeconds: number | null;
  actions: string[];
}): Promise<void> {
  const consent = await consentFor(emailAccountId);
  if (!consent) return;

  publishEntity(
    consent.slug,
    "approvals",
    approvalsPayload({ pending, oldestWaitingSeconds, actions }),
  );
}

/**
 * Service-level health: no account, no mail, no addresses — so unlike the
 * four publishers above, this needs no opt-in and no slug. Callers wrap every
 * call in `.catch(() => {})`: this is a notification path and must never
 * affect an agent run or a cron pass.
 */
export async function publishServiceHealth(
  entity: ServiceEntity,
  state: string,
  attributes: Record<string, unknown>,
): Promise<void> {
  const meta = SERVICE_ENTITY_META[entity];

  // A typo should be loud, not quietly register an entity nothing announced.
  if (!meta) {
    logger.error("Refusing to publish an unknown MQTT entity", { entity });
    return;
  }

  publishRetained(
    serviceTopics(entity),
    serviceDiscoveryConfig({ entity, ...meta }),
    { state, attributes },
  );
}

/**
 * Retained topics outlive the account that made them: opting out or renaming a
 * slug would otherwise leave stale topics and orphaned Home Assistant entities
 * forever. An empty retained payload is how MQTT deletes one.
 */
export function clearAccountTopics(slug: string): void {
  // The account row has already flipped by the time this runs, so consentFor
  // would refuse before anything could be cleared. Validate independently.
  if (!isValidSlug(slug)) {
    logger.error("Refusing to clear MQTT topics for an invalid slug", {
      slug,
    });
    return;
  }

  for (const entity of Object.keys(ENTITY_META) as MqttEntity[]) {
    const topics = entityTopics(slug, entity);
    publishMqtt(topics.config, "", { retain: true });
    publishMqtt(topics.state, "", { retain: true });
    publishMqtt(topics.attributes, "", { retain: true });
  }
}

async function consentFor(emailAccountId: string): Promise<Consent | null> {
  if (!isMqttConfigured()) return null;

  const account = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: {
      mqttEnabled: true,
      mqttTopicSlug: true,
      mqttIncludeDetail: true,
    },
  });

  if (!account?.mqttEnabled) return null;

  const slug = account.mqttTopicSlug;

  // A malformed slug would corrupt the topic string, so refuse rather than
  // publish somewhere unintended.
  if (!slug || !isValidSlug(slug)) {
    logger.warn("Skipping MQTT publish: account has no usable topic slug", {
      emailAccountId,
    });
    return null;
  }

  return { slug, includeDetail: account.mqttIncludeDetail };
}

function publishEntity(
  slug: string,
  entity: MqttEntity,
  built: { state: string; attributes: Record<string, unknown> },
) {
  const meta = ENTITY_META[entity];

  // A typo should be loud, not quietly register an entity nothing announced
  // and that no dashboard will ever explain.
  if (!meta) {
    logger.error("Refusing to publish an unknown MQTT entity", { entity });
    return;
  }

  publishRetained(
    entityTopics(slug, entity),
    discoveryConfig({ slug, entity, ...meta }),
    built,
  );
}

/**
 * The retained config/state/attributes publish shared by the per-account and
 * service-level paths — the only difference between them is how the topics
 * and discovery config are built.
 */
function publishRetained(
  topics: { config: string; state: string; attributes: string },
  config: Record<string, unknown>,
  built: { state: string; attributes: Record<string, unknown> },
) {
  // Retained throughout: a subscriber connecting at noon should learn current
  // state immediately rather than waiting for the next change.
  publishMqtt(topics.config, JSON.stringify(config), { retain: true });
  publishMqtt(topics.state, built.state, { retain: true });
  publishMqtt(topics.attributes, JSON.stringify(built.attributes), {
    retain: true,
  });
}
