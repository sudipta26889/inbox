
-- AlterTable
ALTER TABLE "a2a_approvals" ADD COLUMN     "actionKey" TEXT,
ADD COLUMN     "consumedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "a2a_approvals_actionKey_status_consumedAt_idx" ON "a2a_approvals"("actionKey", "status", "consumedAt");

