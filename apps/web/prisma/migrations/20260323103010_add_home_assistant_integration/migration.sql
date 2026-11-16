-- AlterEnum
ALTER TYPE "ActionType" ADD VALUE 'HOME_ASSISTANT';

-- AlterTable
ALTER TABLE "Action" ADD COLUMN     "haEntityId" TEXT,
ADD COLUMN     "haIntegrationType" TEXT,
ADD COLUMN     "haMqttTopic" TEXT,
ADD COLUMN     "haServiceData" JSONB,
ADD COLUMN     "haServiceDomain" TEXT,
ADD COLUMN     "haServiceName" TEXT,
ADD COLUMN     "haWebhookId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "homeAssistantToken" TEXT,
ADD COLUMN     "homeAssistantUrl" TEXT;
