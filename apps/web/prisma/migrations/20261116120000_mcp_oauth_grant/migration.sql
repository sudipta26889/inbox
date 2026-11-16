-- AlterTable
ALTER TABLE "McpServerAuthorizationCode" ADD COLUMN "grantId" TEXT;

-- AlterTable
ALTER TABLE "McpServerAccessToken" ADD COLUMN "grantId" TEXT,
ADD COLUMN "revokedReason" TEXT;

-- CreateIndex
CREATE INDEX "McpServerAccessToken_grantId_idx" ON "McpServerAccessToken"("grantId");
