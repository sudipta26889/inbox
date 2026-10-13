/**
 * One-time cleanup: resolve open NEEDS_REPLY trackers whose thread the user
 * already answered (the last message is theirs). They piled up because polling
 * never processed sent mail before Gmail push went live on 2026-10-12.
 *
 * Dry run by default; prints counts per mailbox.
 *   pnpm exec dotenv -e .env -- pnpm exec tsx scripts/resolve-replied-trackers.ts [--apply] [--email someone@example.com]
 */
import { ThreadTrackerType } from "@/generated/prisma/enums";
import { createEmailProvider } from "@/utils/email/provider";
import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";

const logger = createScopedLogger("resolve-replied-trackers");
const apply = process.argv.includes("--apply");
const emailIndex = process.argv.indexOf("--email");
const onlyEmail = emailIndex === -1 ? undefined : process.argv[emailIndex + 1];

async function main() {
  if (emailIndex !== -1 && (!onlyEmail || onlyEmail.startsWith("--"))) {
    console.error("--email requires a value");
    process.exitCode = 1;
    return;
  }

  console.log(apply ? "Mode: APPLY" : "Mode: DRY RUN (no changes)");

  const emailAccounts = await prisma.emailAccount.findMany({
    where: onlyEmail ? { email: onlyEmail } : {},
    select: {
      id: true,
      email: true,
      account: { select: { provider: true, disconnectedAt: true } },
    },
  });

  for (const emailAccount of emailAccounts) {
    if (!emailAccount.account?.provider || emailAccount.account.disconnectedAt)
      continue;

    try {
      const trackers = await prisma.threadTracker.findMany({
        where: {
          emailAccountId: emailAccount.id,
          resolved: false,
          type: ThreadTrackerType.NEEDS_REPLY,
        },
        select: { id: true, threadId: true },
      });
      if (!trackers.length) continue;

      const provider = await createEmailProvider({
        emailAccountId: emailAccount.id,
        provider: emailAccount.account.provider,
        logger,
      });

      const answered: string[] = [];
      let failed = 0;
      for (const tracker of trackers) {
        try {
          const latest = await provider.getLatestMessageInThread(
            tracker.threadId,
          );
          if (latest && provider.isSentMessage(latest))
            answered.push(tracker.id);
        } catch {
          failed++;
        }
      }

      console.log(
        `${emailAccount.email}: ${answered.length}/${trackers.length} already answered, ${failed} could not be checked`,
      );

      if (apply && answered.length) {
        await prisma.threadTracker.updateMany({
          where: { id: { in: answered } },
          data: { resolved: true },
        });
        console.log(`  resolved ${answered.length}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`${emailAccount.email}: skipped (${message})`);
    }
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
