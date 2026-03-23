-- AlterTable
ALTER TABLE "a2a_webhook_deliveries" ADD COLUMN     "clientId" TEXT,
ADD COLUMN     "errorMessage" TEXT,
ADD COLUMN     "event" TEXT,
ADD COLUMN     "signature" TEXT,
ALTER COLUMN "maxAttempts" SET DEFAULT 5;

-- Set defaults for existing rows (if any)
UPDATE "a2a_webhook_deliveries" SET "clientId" = 'unknown' WHERE "clientId" IS NULL;
UPDATE "a2a_webhook_deliveries" SET "event" = 'task.state_changed' WHERE "event" IS NULL;

-- Now make columns NOT NULL
ALTER TABLE "a2a_webhook_deliveries" ALTER COLUMN "clientId" SET NOT NULL;
ALTER TABLE "a2a_webhook_deliveries" ALTER COLUMN "event" SET NOT NULL;

-- CreateTable
CREATE TABLE "a2a_webhook_configs" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "events" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "a2a_webhook_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "a2a_webhook_configs_clientId_key" ON "a2a_webhook_configs"("clientId");

-- CreateIndex
CREATE INDEX "a2a_webhook_configs_clientId_idx" ON "a2a_webhook_configs"("clientId");

-- CreateIndex
CREATE INDEX "a2a_webhook_deliveries_clientId_idx" ON "a2a_webhook_deliveries"("clientId");
