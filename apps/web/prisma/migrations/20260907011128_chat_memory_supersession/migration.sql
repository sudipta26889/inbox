
-- CreateEnum
CREATE TYPE "MemorySource" AS ENUM ('USER_STATED', 'AGENT_INFERRED');

-- AlterTable
ALTER TABLE "ChatMemory" ADD COLUMN     "source" "MemorySource" NOT NULL DEFAULT 'AGENT_INFERRED',
ADD COLUMN     "subject" TEXT,
ADD COLUMN     "supersededAt" TIMESTAMP(3),
ADD COLUMN     "supersededById" TEXT,
ADD COLUMN     "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE UNIQUE INDEX "ChatMemory_supersededById_key" ON "ChatMemory"("supersededById");

-- CreateIndex
CREATE INDEX "ChatMemory_emailAccountId_supersededAt_idx" ON "ChatMemory"("emailAccountId", "supersededAt");

-- CreateIndex
CREATE INDEX "ChatMemory_emailAccountId_subject_supersededAt_idx" ON "ChatMemory"("emailAccountId", "subject", "supersededAt");

-- AddForeignKey
ALTER TABLE "ChatMemory" ADD CONSTRAINT "ChatMemory_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "ChatMemory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

