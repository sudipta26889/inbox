-- Scope A2A context messages to the calling peer. contextId is peer-chosen,
-- so filtering on it alone let one peer read another's context. Existing rows
-- stay NULL and are returned to no one (fail closed).
ALTER TABLE "a2a_messages" ADD COLUMN "clientId" TEXT;
ALTER TABLE "a2a_messages" ADD COLUMN "userId" TEXT;
ALTER TABLE "a2a_messages" ADD COLUMN "emailAccountId" TEXT;

CREATE INDEX "a2a_messages_contextId_clientId_userId_emailAccountId_idx"
  ON "a2a_messages" ("contextId", "clientId", "userId", "emailAccountId");
