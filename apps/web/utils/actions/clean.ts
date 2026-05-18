"use server";

import {
  cleanInboxSchema,
  undoCleanInboxSchema,
  changeKeepToDoneSchema,
} from "@/utils/actions/clean.validation";
import {
  getLabel,
  getOrCreateInboxZeroLabel,
  GmailLabel,
  labelThread,
} from "@/utils/gmail/label";
import { inboxZeroLabels } from "@/utils/label";
import prisma from "@/utils/prisma";
import { CleanAction } from "@/generated/prisma/enums";
import { updateThread } from "@/utils/redis/clean";
import { getGmailClientForEmail } from "@/utils/account";
import { actionClient } from "@/utils/actions/safe-action";
import { SafeError } from "@/utils/error";
import { createCleanupJob } from "@/utils/clean/domain";

export const cleanInboxAction = actionClient
  .metadata({ name: "cleanInbox" })
  .inputSchema(cleanInboxSchema)
  .action(
    async ({
      ctx: { emailAccountId, provider, userId, logger },
      parsedInput: { action, instructions, daysOld, skips, maxEmails },
    }) => {
      try {
        const result = await createCleanupJob(
          { userId, emailAccountId, provider, logger },
          {
            action,
            daysOld,
            instructions,
            maxEmails,
            skips: {
              reply: skips.reply ?? true,
              starred: skips.starred ?? true,
              calendar: skips.calendar ?? true,
              receipt: skips.receipt ?? false,
              attachment: skips.attachment ?? false,
              conversation: skips.conversation ?? false,
            },
            confirm: true,
          },
        );
        if (result.dryRun) {
          throw new SafeError("Unexpected dry-run result");
        }
        return { jobId: result.data.jobId };
      } catch (error) {
        if (error instanceof SafeError) throw error;
        if (error instanceof Error) throw new SafeError(error.message);
        throw new SafeError("Failed to create cleanup job");
      }
    },
  );

export const undoCleanInboxAction = actionClient
  .metadata({ name: "undoCleanInbox" })
  .inputSchema(undoCleanInboxSchema)
  .action(
    async ({
      ctx: { emailAccountId, logger },
      parsedInput: { threadId, markedDone, action },
    }) => {
      const gmail = await getGmailClientForEmail({ emailAccountId, logger });

      // nothing to do atm if wasn't marked done
      if (!markedDone) return { success: true };

      // get the label to remove
      const markedDoneLabel = await getLabel({
        name:
          action === CleanAction.ARCHIVE
            ? inboxZeroLabels.archived.name
            : inboxZeroLabels.marked_read.name,
        gmail,
      });

      await labelThread({
        gmail,
        threadId,
        // undo core action
        addLabelIds:
          action === CleanAction.ARCHIVE
            ? [GmailLabel.INBOX]
            : [GmailLabel.UNREAD],
        // undo our own labelling
        removeLabelIds: markedDoneLabel?.id ? [markedDoneLabel.id] : undefined,
      });

      // Update Redis to mark this thread as undone
      try {
        // We need to get the thread first to get the jobId
        const thread = await prisma.cleanupThread.findFirst({
          where: { emailAccountId, threadId },
          orderBy: { createdAt: "desc" },
        });

        if (thread) {
          await updateThread({
            emailAccountId,
            jobId: thread.jobId,
            threadId,
            update: {
              undone: true,
              archive: false, // Reset the archive status since we've undone it
            },
          });
        }
      } catch (error) {
        logger.error("Failed to update Redis for undone thread", {
          error,
          threadId,
        });
        // Continue even if Redis update fails
      }

      return { success: true };
    },
  );

export const changeKeepToDoneAction = actionClient
  .metadata({ name: "changeKeepToDone" })
  .inputSchema(changeKeepToDoneSchema)
  .action(
    async ({
      ctx: { emailAccountId, logger },
      parsedInput: { threadId, action },
    }) => {
      const gmail = await getGmailClientForEmail({ emailAccountId, logger });

      // Get the label to add (archived or marked_read)
      const actionLabel = await getOrCreateInboxZeroLabel({
        key: action === CleanAction.ARCHIVE ? "archived" : "marked_read",
        gmail,
      });

      await labelThread({
        gmail,
        threadId,
        // Apply the action (archive or mark as read)
        removeLabelIds: [
          ...(action === CleanAction.ARCHIVE ? [GmailLabel.INBOX] : []),
          ...(action === CleanAction.MARK_READ ? [GmailLabel.UNREAD] : []),
        ],
        addLabelIds: [...(actionLabel?.id ? [actionLabel.id] : [])],
      });

      // Update Redis to mark this thread with the new status
      try {
        // We need to get the thread first to get the jobId
        const thread = await prisma.cleanupThread.findFirst({
          where: { emailAccountId, threadId },
          orderBy: { createdAt: "desc" },
        });

        if (thread) {
          // await updateThread(userId, thread.jobId, threadId, {
          //   archive: action === CleanAction.ARCHIVE,
          //   status: "completed",
          //   undone: true,
          // });

          await updateThread({
            emailAccountId,
            jobId: thread.jobId,
            threadId,
            update: {
              archive: action === CleanAction.ARCHIVE,
              status: "completed",
              undone: true,
            },
          });
        }
      } catch (error) {
        logger.error("Failed to update Redis for changed thread:", {
          error,
          threadId,
        });
        // Continue even if Redis update fails
      }

      return { success: true };
    },
  );
