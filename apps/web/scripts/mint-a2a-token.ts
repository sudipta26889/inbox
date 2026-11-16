/**
 * Mint a long-lived A2A access token for a peer that cannot run an OAuth
 * refresh loop.
 *
 * Why this exists: refresh tokens live 30 days and every refresh ROTATES the
 * pair, revoking the previous record. A peer whose refresher stalls — or whose
 * refresh response is lost in flight after the server already rotated — is
 * locked out permanently, with no way back except re-running the authorization
 * flow by hand. That is what happened to OpenClaw-Mitra.
 *
 * The token minted here is an ordinary access token: same signature, same
 * `revoked` check on every request, visible and revocable in
 * Settings -> A2A Protocol Clients. It simply expires far in the future and
 * carries no refresh token, so nothing can rotate it away.
 *
 *   pnpm exec dotenv -e .env -- pnpm exec tsx scripts/mint-a2a-token.ts \
 *     --client <clientId> [--days 3650] [--scope "email:read calendar:read"]
 */
import { env } from "@/env";
import { createScopedLogger } from "@/utils/logger";
import { generateAccessToken } from "@/utils/mcp-server/tokens";
import prisma from "@/utils/prisma";

const logger = createScopedLogger("mint-a2a-token");

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const clientId = arg("client");
  if (!clientId) {
    throw new Error("--client <clientId> is required");
  }

  const days = Number(arg("days") ?? 3650);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error("--days must be a positive number");
  }

  const client = await prisma.mcpServerClient.findUnique({
    where: { clientId },
    select: { clientId: true, clientName: true, userId: true, type: true },
  });

  if (!client) throw new Error(`No client with clientId ${clientId}`);
  // userId is nullable on the model, but an A2A client without an owner has
  // nothing to mint against.
  if (!client.userId) {
    throw new Error(`Client ${clientId} has no owning user`);
  }
  const ownerId = client.userId;

  const emailAccount = await prisma.emailAccount.findFirst({
    where: { userId: ownerId },
    select: { id: true, email: true },
    orderBy: { createdAt: "asc" },
  });

  if (!emailAccount) {
    throw new Error(`No email account for user ${ownerId}`);
  }

  // Read-only by default: a token this long-lived should not be able to send
  // mail or write to the calendar unless someone asks for that explicitly.
  const scope =
    arg("scope") ?? "email:read calendar:read stats:read rules:read";

  const jwtSecret = env.AUTH_SECRET || env.NEXTAUTH_SECRET || "";
  if (!jwtSecret) throw new Error("AUTH_SECRET is not set");

  const { accessToken, expiresIn } = await generateAccessToken({
    userId: ownerId,
    emailAccountId: emailAccount.id,
    clientId: client.clientId,
    scope,
    jwtSecret,
    accessTokenTtlSeconds: Math.floor(days * 24 * 60 * 60),
  });

  // generateAccessToken always mints a refresh token alongside the access one.
  // For a static peer token that is a footgun: refreshAccessToken rotates the
  // pair and REVOKES the old record, so anything that ever replayed the refresh
  // token would silently kill this credential — the very lockout this script
  // exists to avoid. Detach it so the row cannot be rotated.
  const cleared = await prisma.mcpServerAccessToken.updateMany({
    where: {
      clientId: client.clientId,
      revoked: false,
      refreshToken: { not: null },
    },
    data: { refreshToken: null },
  });
  logger.info("Detached refresh tokens from static peer credentials", {
    clientId: client.clientId,
    rows: cleared.count,
  });

  logger.info("Minted long-lived A2A token", {
    clientName: client.clientName,
    clientId: client.clientId,
    days,
    scope,
  });

  console.log(
    JSON.stringify(
      {
        client: client.clientName,
        clientId: client.clientId,
        boundEmailAccount: emailAccount.email,
        scope,
        expiresInDays: Math.round(expiresIn / 86_400),
        rotatable: false,
        expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
        accessToken,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
