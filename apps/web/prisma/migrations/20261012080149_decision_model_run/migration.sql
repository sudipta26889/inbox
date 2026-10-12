-- CreateTable
CREATE TABLE "DecisionModelRun" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "emailAccountId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "model" TEXT,
    "subjectKey" TEXT,
    "jevResult" JSONB,
    "llmResult" JSONB,
    "answers" JSONB,
    "latencyMs" INTEGER,
    "error" TEXT,

    CONSTRAINT "DecisionModelRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DecisionModelRun_emailAccountId_feature_createdAt_idx" ON "DecisionModelRun"("emailAccountId", "feature", "createdAt");

-- CreateIndex
CREATE INDEX "DecisionModelRun_feature_outcome_createdAt_idx" ON "DecisionModelRun"("feature", "outcome", "createdAt");

-- AddForeignKey
ALTER TABLE "DecisionModelRun" ADD CONSTRAINT "DecisionModelRun_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

