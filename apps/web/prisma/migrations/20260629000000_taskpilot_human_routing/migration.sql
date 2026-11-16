-- DropIndex
DROP INDEX "EmailTaskLink_emailAccountId_gmailMessageId_key";

-- CreateTable
CREATE TABLE "TaskpilotDecision" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "threadId" TEXT,
    "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "preGateInvoked" BOOLEAN NOT NULL,
    "preGateSignals" JSONB NOT NULL,
    "candidateIssueIds" TEXT[],
    "pass1Model" TEXT,
    "pass1Effort" TEXT,
    "pass1DurationMs" INTEGER,
    "pass1InputTokens" INTEGER,
    "pass1OutputTokens" INTEGER,
    "pass1Action" TEXT,
    "pass1Decision" JSONB,
    "pass1Reason" TEXT,
    "pass2Ran" BOOLEAN NOT NULL DEFAULT false,
    "pass2Model" TEXT,
    "pass2DurationMs" INTEGER,
    "pass2InputTokens" INTEGER,
    "pass2OutputTokens" INTEGER,
    "pass2Updates" JSONB,
    "targetIssueIds" TEXT[],
    "commentsPosted" INTEGER NOT NULL DEFAULT 0,
    "stateMovesApplied" INTEGER NOT NULL DEFAULT 0,
    "fieldUpdatesApplied" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "errorMsg" TEXT,

    CONSTRAINT "TaskpilotDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskpilotDecision_emailAccountId_ranAt_idx" ON "TaskpilotDecision"("emailAccountId", "ranAt" DESC);

-- CreateIndex
CREATE INDEX "TaskpilotDecision_emailAccountId_status_idx" ON "TaskpilotDecision"("emailAccountId", "status");

-- CreateIndex
CREATE INDEX "TaskpilotDecision_gmailMessageId_idx" ON "TaskpilotDecision"("gmailMessageId");

-- CreateIndex
CREATE INDEX "EmailTaskLink_emailAccountId_gmailMessageId_idx" ON "EmailTaskLink"("emailAccountId", "gmailMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailTaskLink_emailAccountId_gmailMessageId_taskpilotIssueI_key" ON "EmailTaskLink"("emailAccountId", "gmailMessageId", "taskpilotIssueId");

-- AddForeignKey
ALTER TABLE "TaskpilotDecision" ADD CONSTRAINT "TaskpilotDecision_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
