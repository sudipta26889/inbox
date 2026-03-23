-- CreateEnum
CREATE TYPE "ClientType" AS ENUM ('MCP', 'A2A');

-- CreateEnum
CREATE TYPE "a2a_task_state" AS ENUM ('submitted', 'working', 'input_required', 'auth_required', 'completed', 'failed', 'canceled', 'rejected', 'unknown');

-- CreateEnum
CREATE TYPE "a2a_message_role" AS ENUM ('user', 'agent', 'system');

-- CreateEnum
CREATE TYPE "a2a_approval_status" AS ENUM ('pending', 'approved', 'rejected', 'expired');

-- CreateEnum
CREATE TYPE "a2a_webhook_status" AS ENUM ('pending', 'delivered', 'failed');

-- AlterTable
ALTER TABLE "McpServerClient" ADD COLUMN     "description" TEXT,
ADD COLUMN     "lastUsedAt" TIMESTAMP(3),
ADD COLUMN     "type" "ClientType" NOT NULL DEFAULT 'MCP',
ADD COLUMN     "userId" TEXT;

-- CreateTable
CREATE TABLE "a2a_tasks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emailAccountId" TEXT,
    "clientId" TEXT,
    "contextId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "skill" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "state" "a2a_task_state" NOT NULL,
    "stateReason" TEXT,
    "result" JSONB,
    "artifacts" JSONB,
    "error" JSONB,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "approvalStatus" "a2a_approval_status",
    "approvalData" JSONB,
    "approvalRequestedAt" TIMESTAMP(3),
    "pushNotificationUrl" TEXT,
    "pushNotificationToken" TEXT,
    "pushNotificationAuth" JSONB,
    "referenceTaskIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "a2a_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "a2a_task_history" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "fromState" "a2a_task_state" NOT NULL,
    "toState" "a2a_task_state" NOT NULL,
    "reason" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    "durationMs" INTEGER,

    CONSTRAINT "a2a_task_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "a2a_messages" (
    "id" TEXT NOT NULL,
    "contextId" TEXT NOT NULL,
    "taskId" TEXT,
    "role" "a2a_message_role" NOT NULL,
    "content" JSONB NOT NULL,
    "contentType" TEXT NOT NULL DEFAULT 'text',
    "referenceTaskIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "a2a_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "a2a_approvals" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "skill" TEXT NOT NULL,
    "requestData" JSONB NOT NULL,
    "requestReason" TEXT,
    "status" "a2a_approval_status" NOT NULL DEFAULT 'pending',
    "approverId" TEXT,
    "approverEmail" TEXT,
    "approverChannel" TEXT,
    "approved" BOOLEAN,
    "rejectionReason" TEXT,
    "responseData" JSONB,
    "dharahilRequestId" TEXT,
    "dharahilChannel" TEXT,
    "dharahilMessageId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "a2a_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "a2a_agent_card_signatures" (
    "id" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL,
    "publicKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "a2a_agent_card_signatures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "a2a_webhook_deliveries" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'POST',
    "payload" JSONB NOT NULL,
    "status" "a2a_webhook_status" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextAttemptAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "a2a_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "a2a_rate_limits" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "userId" TEXT,
    "ipAddress" TEXT,
    "limitType" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "a2a_rate_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "a2a_audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "clientId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "operation" TEXT NOT NULL,
    "taskId" TEXT,
    "contextId" TEXT,
    "skill" TEXT,
    "success" BOOLEAN NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "durationMs" INTEGER NOT NULL,
    "metadata" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "a2a_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "a2a_tasks_taskId_key" ON "a2a_tasks"("taskId");

-- CreateIndex
CREATE INDEX "a2a_tasks_userId_idx" ON "a2a_tasks"("userId");

-- CreateIndex
CREATE INDEX "a2a_tasks_contextId_idx" ON "a2a_tasks"("contextId");

-- CreateIndex
CREATE INDEX "a2a_tasks_state_idx" ON "a2a_tasks"("state");

-- CreateIndex
CREATE INDEX "a2a_tasks_createdAt_idx" ON "a2a_tasks"("createdAt");

-- CreateIndex
CREATE INDEX "a2a_tasks_taskId_idx" ON "a2a_tasks"("taskId");

-- CreateIndex
CREATE INDEX "a2a_tasks_clientId_idx" ON "a2a_tasks"("clientId");

-- CreateIndex
CREATE INDEX "a2a_task_history_taskId_idx" ON "a2a_task_history"("taskId");

-- CreateIndex
CREATE INDEX "a2a_task_history_timestamp_idx" ON "a2a_task_history"("timestamp");

-- CreateIndex
CREATE INDEX "a2a_task_history_toState_idx" ON "a2a_task_history"("toState");

-- CreateIndex
CREATE INDEX "a2a_messages_contextId_idx" ON "a2a_messages"("contextId");

-- CreateIndex
CREATE INDEX "a2a_messages_taskId_idx" ON "a2a_messages"("taskId");

-- CreateIndex
CREATE INDEX "a2a_messages_createdAt_idx" ON "a2a_messages"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "a2a_approvals_taskId_key" ON "a2a_approvals"("taskId");

-- CreateIndex
CREATE INDEX "a2a_approvals_status_idx" ON "a2a_approvals"("status");

-- CreateIndex
CREATE INDEX "a2a_approvals_requestedAt_idx" ON "a2a_approvals"("requestedAt");

-- CreateIndex
CREATE INDEX "a2a_approvals_taskId_idx" ON "a2a_approvals"("taskId");

-- CreateIndex
CREATE INDEX "a2a_agent_card_signatures_createdAt_idx" ON "a2a_agent_card_signatures"("createdAt");

-- CreateIndex
CREATE INDEX "a2a_agent_card_signatures_keyId_idx" ON "a2a_agent_card_signatures"("keyId");

-- CreateIndex
CREATE INDEX "a2a_webhook_deliveries_taskId_idx" ON "a2a_webhook_deliveries"("taskId");

-- CreateIndex
CREATE INDEX "a2a_webhook_deliveries_status_idx" ON "a2a_webhook_deliveries"("status");

-- CreateIndex
CREATE INDEX "a2a_webhook_deliveries_nextAttemptAt_idx" ON "a2a_webhook_deliveries"("nextAttemptAt");

-- CreateIndex
CREATE INDEX "a2a_rate_limits_windowEnd_idx" ON "a2a_rate_limits"("windowEnd");

-- CreateIndex
CREATE UNIQUE INDEX "a2a_rate_limits_limitType_clientId_userId_ipAddress_windowS_key" ON "a2a_rate_limits"("limitType", "clientId", "userId", "ipAddress", "windowStart");

-- CreateIndex
CREATE INDEX "a2a_audit_logs_userId_idx" ON "a2a_audit_logs"("userId");

-- CreateIndex
CREATE INDEX "a2a_audit_logs_clientId_idx" ON "a2a_audit_logs"("clientId");

-- CreateIndex
CREATE INDEX "a2a_audit_logs_timestamp_idx" ON "a2a_audit_logs"("timestamp");

-- CreateIndex
CREATE INDEX "a2a_audit_logs_operation_idx" ON "a2a_audit_logs"("operation");

-- CreateIndex
CREATE INDEX "McpServerClient_userId_idx" ON "McpServerClient"("userId");

-- CreateIndex
CREATE INDEX "McpServerClient_type_idx" ON "McpServerClient"("type");

-- AddForeignKey
ALTER TABLE "McpServerClient" ADD CONSTRAINT "McpServerClient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "a2a_tasks" ADD CONSTRAINT "a2a_tasks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "a2a_tasks" ADD CONSTRAINT "a2a_tasks_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "a2a_task_history" ADD CONSTRAINT "a2a_task_history_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "a2a_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "a2a_messages" ADD CONSTRAINT "a2a_messages_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "a2a_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
