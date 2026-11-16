-- AlterTable
ALTER TABLE "ExecutedAction" ADD COLUMN     "haEntityId" TEXT,
ADD COLUMN     "haIntegrationType" TEXT,
ADD COLUMN     "haMqttTopic" TEXT,
ADD COLUMN     "haServiceData" JSONB,
ADD COLUMN     "haServiceDomain" TEXT,
ADD COLUMN     "haServiceName" TEXT,
ADD COLUMN     "haWebhookId" TEXT;

-- AlterTable
ALTER TABLE "ScheduledAction" ADD COLUMN     "haEntityId" TEXT,
ADD COLUMN     "haIntegrationType" TEXT,
ADD COLUMN     "haMqttTopic" TEXT,
ADD COLUMN     "haServiceData" JSONB,
ADD COLUMN     "haServiceDomain" TEXT,
ADD COLUMN     "haServiceName" TEXT,
ADD COLUMN     "haWebhookId" TEXT;
