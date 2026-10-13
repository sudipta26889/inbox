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
    for (const tracker of trackers) {
      const latest = await provider
        .getLatestMessageInThread(tracker.threadId)
        .catch(() => null);
      if (latest && provider.isSentMessage(latest)) answered.push(tracker.id);
    }

    console.log(
      `${emailAccount.email}: ${answered.length}/${trackers.length} open NEEDS_REPLY already answered`,
    );

    if (apply && answered.length) {
      await prisma.threadTracker.updateMany({
        where: { id: { in: answered } },
        data: { resolved: true },
      });
      console.log(`  resolved ${answered.length}`);
    }
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
