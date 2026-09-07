-- AlterTable
ALTER TABLE "EmailAccount" ADD COLUMN     "mqttEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mqttIncludeDetail" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mqttTopicSlug" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "EmailAccount_mqttTopicSlug_key" ON "EmailAccount"("mqttTopicSlug");

