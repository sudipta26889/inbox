import "server-only";

/**
 * Topic and payload construction for the MQTT agent bus.
 *
 * Pure on purpose: the privacy rules are the load-bearing part of this feature
 * and they should be testable without a broker. Nothing here does I/O.
 *
 * The shape follows the convention already on this broker — availability plus
 * per-entity state/attributes, with retained Home Assistant discovery configs.
 * Matching it means Inbox appears as real HA entities rather than as ad-hoc
 * topics nothing knows how to read.
 */

export const AVAILABILITY_TOPIC = "inbox/availability";
const DISCOVERY_PREFIX = "homeassistant/sensor";

export type MqttEntity = "unread" | "urgent" | "digest" | "approvals";

/**
 * A slug is substituted into a topic string and an HA `unique_id`, so a slash
 * or a wildcard would silently reroute or corrupt another account's topics.
 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,30}$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

export function entityTopics(slug: string, entity: MqttEntity) {
  return {
    state: `inbox/${slug}/${entity}/state`,
    attributes: `inbox/${slug}/${entity}/attributes`,
    config: `${DISCOVERY_PREFIX}/inbox_${slug}/${entity}/config`,
  };
}

export function discoveryConfig({
  slug,
  entity,
  name,
  icon,
}: {
  slug: string;
  entity: MqttEntity;
  name: string;
  icon: string;
}): Record<string, unknown> {
  const topics = entityTopics(slug, entity);

  return {
    name,
    unique_id: `inbox_${slug}_${entity}`,
    state_topic: topics.state,
    json_attributes_topic: topics.attributes,
    availability_topic: AVAILABILITY_TOPIC,
    // One HA device per opted-in account, so the privacy boundary stays visible
    // in Home Assistant rather than merging several people's mail into one.
    device: {
      identifiers: [`inbox_${slug}`],
      name: `Inbox – ${slug}`,
      manufacturer: "Dhara AI",
      model: "email-agent",
    },
    icon,
  };
}

export function unreadPayload({
  unread,
  total,
}: {
  unread: number;
  total: number;
}) {
  return { state: String(unread), attributes: { total } };
}

export function urgentPayload({
  ruleName,
  countToday,
  at,
  detail,
}: {
  ruleName: string;
  countToday: number;
  at: string;
  /** Only supplied when the account has mqttIncludeDetail. */
  detail?: { subject: string; from: string };
}) {
  return {
    state: ruleName,
    attributes: { count_today: countToday, at, ...(detail ?? {}) },
  };
}

export function digestPayload({ items, at }: { items: number; at: string }) {
  return { state: "ready", attributes: { items, at } };
}

export function approvalsPayload({
  pending,
  oldestWaitingSeconds,
  actions,
}: {
  pending: number;
  oldestWaitingSeconds: number | null;
  actions: string[];
}) {
  return {
    state: String(pending),
    attributes: { oldest_waiting_seconds: oldestWaitingSeconds, actions },
  };
}
