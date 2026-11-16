import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Staging boots a refork image whose start.sh runs prisma migrate deploy.
// Pointed at production by mistake (an Env pasted from stack 209), it would
// apply upstream's migrations to the production database, which cannot be
// undone. The guard stops the container unless every database URL names an
// inbox_refork_* database. It must never print a URL.
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const GUARD = join(REPO_ROOT, "docker/scripts/staging-db-guard.sh");
const SECRET = "s3cret-password";

function runGuard(env: Record<string, string>) {
  return spawnSync("sh", [GUARD], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
  });
}

const url = (db: string) =>
  `postgresql://inbox_rehearsal:${SECRET}@db.lan:5432/${db}?schema=public`;

describe("staging database guard", () => {
  it("allows a refork clone", () => {
    const result = runGuard({
      DHARAHIL_ENVIRONMENT: "staging",
      DATABASE_URL: url("inbox_refork_rehearsal"),
      DIRECT_URL: url("inbox_refork_rehearsal"),
    });

    expect(result.status).toBe(0);
  });

  it.each([
    ["DATABASE_URL", { DATABASE_URL: url("inbox_prod") }],
    [
      "DIRECT_URL",
      {
        DATABASE_URL: url("inbox_refork_rehearsal"),
        DIRECT_URL: url("inbox_prod"),
      },
    ],
    ["no URL at all", {}],
  ])("stops staging on a non-refork %s without printing it", (_name, urls) => {
    const result = runGuard({ DHARAHIL_ENVIRONMENT: "staging", ...urls });

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain(SECRET);
    expect(result.stdout + result.stderr).not.toContain("db.lan");
  });

  it("does nothing outside staging", () => {
    const result = runGuard({
      DHARAHIL_ENVIRONMENT: "production",
      DATABASE_URL: url("inbox_prod"),
    });

    expect(result.status).toBe(0);
  });

  it("runs in start.sh before migrations", () => {
    const start = readFileSync(join(REPO_ROOT, "docker/scripts/start.sh"), "utf8");

    expect(start.indexOf("staging-db-guard.sh")).toBeGreaterThan(-1);
    expect(start.indexOf("staging-db-guard.sh")).toBeLessThan(
      start.indexOf("migrate.sh"),
    );
  });
});

describe("staging stack", () => {
  const stack = readFileSync(join(REPO_ROOT, "deploy/stack.staging.yml"), "utf8");

  it.each([
    ["DATABASE_URL", "STAGING_DATABASE_URL"],
    ["DIRECT_URL", "STAGING_DIRECT_URL"],
    ["REDIS_URL", "STAGING_REDIS_URL"],
  ])("takes %s only from a required %s", (appKey, stagingKey) => {
    expect(stack).toMatch(
      new RegExp(`^\\s+${appKey}: \\$\\{${stagingKey}:\\?[^}]*\\}$`, "m"),
    );
    expect(stack).not.toMatch(new RegExp(`\\$\\{${appKey}\\b`));
  });

  it("carries no credential that reaches real people or systems", () => {
    const outbound =
      /^\s+(SMTP_|QDRANT_|OVERMIND_|TELEGRAM_|A2A_|MEETECHO_|LONGMEMORY_|MQTT_|NTFY_|OLLAMA_CLOUD_|GOOGLE_PUBSUB_VERIFICATION|RESEND_|SLACK_|TEAMS_|RECALL_|STRIPE_|LEMON)\w*:/gm;

    expect(stack.match(outbound) ?? []).toEqual([]);
  });

  it("has no cron service", () => {
    expect(stack).not.toMatch(/^\s{2}cron:/m);
  });
});
