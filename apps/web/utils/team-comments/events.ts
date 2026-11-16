import "server-only";
import { EventEmitter } from "node:events";
import Redis from "ioredis";
import { env } from "@/env";
import { REDIS_KEY_PREFIX } from "@/utils/redis/key-prefix";
import type { Logger } from "@/utils/logger";

declare global {
  var teamConversationEvents: EventEmitter | undefined;
  var teamConversationPublisher: Redis | undefined;
}

const localEvents = global.teamConversationEvents ?? new EventEmitter();
global.teamConversationEvents = localEvents;

export function conversationChangeChannel(conversationId: string) {
  // Published and subscribed on raw ioredis clients, which do not prefix channels.
  return `${REDIS_KEY_PREFIX}team-comments:${conversationId}`;
}

// With Redis configured, every stream listens on Redis, so the in-process
// emitter is only the fallback for single-process installs without it.
export async function publishConversationChange(
  conversationId: string,
  logger: Logger,
) {
  if (!env.REDIS_URL) {
    localEvents.emit(conversationChangeChannel(conversationId));
    return;
  }
  try {
    await getPublisher(env.REDIS_URL).publish(
      conversationChangeChannel(conversationId),
      "{}",
    );
  } catch (error) {
    logger.warn("Unable to publish conversation invalidation", { error });
  }
}

export function subscribeLocalConversationChange(
  conversationId: string,
  listener: () => void,
) {
  const channel = conversationChangeChannel(conversationId);
  localEvents.on(channel, listener);
  return () => localEvents.off(channel, listener);
}

// Publish on the same Redis that streams subscribe to, over one reused
// connection with bounded retries so a slow Redis cannot stall mutations.
function getPublisher(url: string) {
  if (!global.teamConversationPublisher) {
    global.teamConversationPublisher = new Redis(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
    });
    // Failures surface on publish, where they are logged.
    global.teamConversationPublisher.on("error", () => {});
  }
  return global.teamConversationPublisher;
}
