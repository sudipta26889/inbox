-- CreateEnum
CREATE TYPE "EmailTaskLinkSource" AS ENUM ('MANUAL', 'CHAT', 'RULE');

-- AlterEnum
ALTER TYPE "ActionType" ADD VALUE 'CREATE_TASK';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "taskpilotApiKey" TEXT,
ADD COLUMN     "taskpilotWorkspaceSlug" TEXT;

-- CreateTable
CREATE TABLE "EmailTaskLink" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "threadId" TEXT,
    "workspaceSlug" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskpilotIssueId" TEXT NOT NULL,
    "taskpilotIdentifier" TEXT NOT NULL,
    "source" "EmailTaskLinkSource" NOT NULL,
    "ruleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailTaskLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailTaskLink_emailAccountId_createdAt_idx" ON "EmailTaskLink"("emailAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailTaskLink_ruleId_idx" ON "EmailTaskLink"("ruleId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailTaskLink_emailAccountId_gmailMessageId_key" ON "EmailTaskLink"("emailAccountId", "gmailMessageId");

-- AddForeignKey
ALTER TABLE "EmailTaskLink" ADD CONSTRAINT "EmailTaskLink_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailTaskLink" ADD CONSTRAINT "EmailTaskLink_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
