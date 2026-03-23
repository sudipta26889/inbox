-- AlterTable
ALTER TABLE "a2a_approvals" ADD COLUMN     "revisionInstructions" TEXT,
ADD COLUMN     "revisionRequested" BOOLEAN DEFAULT false;
