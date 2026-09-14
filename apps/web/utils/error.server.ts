import { setUser } from "@sentry/nextjs";
import { auth } from "@/utils/auth";
import type { Logger } from "@/utils/logger";

export async function setSentryErrorUser(logger: Logger) {
  try {
    const session = await auth();
    if (session?.user.email) setUser({ email: session.user.email });
  } catch (error) {
    logger.error("Error setting error user", { error });
  }
}
