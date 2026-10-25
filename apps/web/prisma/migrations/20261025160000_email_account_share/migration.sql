-- CreateTable
CREATE TABLE "EmailAccountShare" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "emailAccountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "EmailAccountShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailAccountShare_userId_idx" ON "EmailAccountShare"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailAccountShare_emailAccountId_userId_key" ON "EmailAccountShare"("emailAccountId", "userId");

-- AddForeignKey
ALTER TABLE "EmailAccountShare" ADD CONSTRAINT "EmailAccountShare_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailAccountShare" ADD CONSTRAINT "EmailAccountShare_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
