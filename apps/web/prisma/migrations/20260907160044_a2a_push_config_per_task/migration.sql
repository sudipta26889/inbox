-- Per-task push notification config (A2A v1.0 §3.1.7).
-- Existing rows become the client-level default (taskId NULL).
ALTER TABLE "a2a_webhook_configs" ADD COLUMN "taskId" TEXT;

DROP INDEX IF EXISTS "a2a_webhook_configs_clientId_key";

-- NULLs do not collide in a Postgres unique index, so this alone would let a
-- client hold many rows with taskId NULL. The partial index below pins the
-- default to one row per client; this one covers the per-task rows.
CREATE UNIQUE INDEX "a2a_webhook_configs_clientId_taskId_key"
  ON "a2a_webhook_configs" ("clientId", "taskId");

CREATE UNIQUE INDEX "a2a_webhook_configs_clientId_default_key"
  ON "a2a_webhook_configs" ("clientId")
  WHERE "taskId" IS NULL;
