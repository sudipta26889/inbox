-- CreateTable
CREATE TABLE "McpServerClient" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT,
    "clientName" TEXT NOT NULL,
    "redirectUris" TEXT[],
    "grantTypes" TEXT[] DEFAULT ARRAY['authorization_code', 'refresh_token']::TEXT[],
    "responseTypes" TEXT[] DEFAULT ARRAY['code']::TEXT[],
    "tokenEndpointAuthMethod" TEXT NOT NULL DEFAULT 'none',
    "scope" TEXT,
    "logoUri" TEXT,
    "tosUri" TEXT,
    "policyUri" TEXT,

    CONSTRAINT "McpServerClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpServerAuthorizationCode" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "code" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "scope" TEXT,
    "state" TEXT,
    "codeChallenge" TEXT NOT NULL,
    "codeChallengeMethod" TEXT NOT NULL DEFAULT 'S256',
    "userId" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "McpServerAuthorizationCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpServerAccessToken" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "tokenType" TEXT NOT NULL DEFAULT 'Bearer',
    "scope" TEXT,
    "userId" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "McpServerAccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "McpServerClient_clientId_key" ON "McpServerClient"("clientId");

-- CreateIndex
CREATE INDEX "McpServerClient_clientId_idx" ON "McpServerClient"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "McpServerAuthorizationCode_code_key" ON "McpServerAuthorizationCode"("code");

-- CreateIndex
CREATE INDEX "McpServerAuthorizationCode_code_idx" ON "McpServerAuthorizationCode"("code");

-- CreateIndex
CREATE INDEX "McpServerAuthorizationCode_expiresAt_idx" ON "McpServerAuthorizationCode"("expiresAt");

-- CreateIndex
CREATE INDEX "McpServerAuthorizationCode_userId_idx" ON "McpServerAuthorizationCode"("userId");

-- CreateIndex
CREATE INDEX "McpServerAuthorizationCode_emailAccountId_idx" ON "McpServerAuthorizationCode"("emailAccountId");

-- CreateIndex
CREATE INDEX "McpServerAuthorizationCode_clientId_idx" ON "McpServerAuthorizationCode"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "McpServerAccessToken_accessToken_key" ON "McpServerAccessToken"("accessToken");

-- CreateIndex
CREATE UNIQUE INDEX "McpServerAccessToken_refreshToken_key" ON "McpServerAccessToken"("refreshToken");

-- CreateIndex
CREATE INDEX "McpServerAccessToken_accessToken_idx" ON "McpServerAccessToken"("accessToken");

-- CreateIndex
CREATE INDEX "McpServerAccessToken_refreshToken_idx" ON "McpServerAccessToken"("refreshToken");

-- CreateIndex
CREATE INDEX "McpServerAccessToken_expiresAt_idx" ON "McpServerAccessToken"("expiresAt");

-- CreateIndex
CREATE INDEX "McpServerAccessToken_userId_idx" ON "McpServerAccessToken"("userId");

-- CreateIndex
CREATE INDEX "McpServerAccessToken_emailAccountId_idx" ON "McpServerAccessToken"("emailAccountId");

-- CreateIndex
CREATE INDEX "McpServerAccessToken_clientId_idx" ON "McpServerAccessToken"("clientId");

-- AddForeignKey
ALTER TABLE "McpServerAuthorizationCode" ADD CONSTRAINT "McpServerAuthorizationCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpServerAuthorizationCode" ADD CONSTRAINT "McpServerAuthorizationCode_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpServerAuthorizationCode" ADD CONSTRAINT "McpServerAuthorizationCode_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "McpServerClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpServerAccessToken" ADD CONSTRAINT "McpServerAccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpServerAccessToken" ADD CONSTRAINT "McpServerAccessToken_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpServerAccessToken" ADD CONSTRAINT "McpServerAccessToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "McpServerClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;
