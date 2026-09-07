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

    // After the write, using the slug captured before it — the freed slug
    // could otherwise be reclaimed by a different account while these
    // retained topics still sat on the broker under the old owner's data.
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
