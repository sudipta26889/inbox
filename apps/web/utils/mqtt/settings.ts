import prisma from "@/utils/prisma";
import { SafeError } from "@/utils/error";
import { isDuplicateError } from "@/utils/prisma-helpers";
import { clearAccountTopics } from "@/utils/mqtt/events";
import type { UpdateMqttSettingsBody } from "@/utils/actions/settings.validation";

/**
 * Opt-in/out for the MQTT agent bus.
 *
 * Retained topics outlive the account that published them (see
 * clearAccountTopics in events.ts), so disabling the bus or renaming the slug
 * must clear whatever was published under the OLD slug. That slug has to be
 * read before the write, since the update below overwrites it.
 */
export async function updateMqttSettings(
  ctx: { emailAccountId: string },
  input: UpdateMqttSettingsBody,
) {
  const previous = await prisma.emailAccount.findUnique({
    where: { id: ctx.emailAccountId },
    select: { mqttEnabled: true, mqttTopicSlug: true },
  });
  if (!previous) throw new SafeError("Email account not found");

  const newSlug = input.mqttTopicSlug.trim() || null;

  const slugChanged = previous.mqttTopicSlug !== newSlug;
  const disabling = previous.mqttEnabled && !input.mqttEnabled;
  const shouldClearPreviousTopics =
    !!previous.mqttTopicSlug && (disabling || slugChanged);

  try {
    const updated = await prisma.emailAccount.update({
      where: { id: ctx.emailAccountId },
      data: {
        mqttEnabled: input.mqttEnabled,
        mqttTopicSlug: newSlug,
        mqttIncludeDetail: input.mqttIncludeDetail,
      },
      select: {
        mqttEnabled: true,
        mqttTopicSlug: true,
        mqttIncludeDetail: true,
      },
    });

    // Cleared only after the write succeeds, using the slug captured before
    // it: the unique index still held the old slug up to this point, so no
    // other account could have claimed it, and a failed update must not wipe
    // topics that are still live under the unchanged slug.
    if (shouldClearPreviousTopics) {
      clearAccountTopics(previous.mqttTopicSlug as string);
    }

    return updated;
  } catch (error) {
    if (isDuplicateError(error, "mqttTopicSlug")) {
      throw new SafeError("That name is already taken");
    }
    throw error;
  }
}
