import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Owner rule: no analytics or tracking calls. Upstream ships PostHog and other
// trackers that stay silent while their keys are unset, so this test keeps the
// keys out of every file that configures a deployment.
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

const ANALYTICS_KEYS = [
  /POSTHOG/,
  /NEXT_PUBLIC_GTM_ID/,
  /CONVERSION_ANALYTICS/,
  /FB_PIXEL_ID/,
  /FB_CONVERSION_API_ACCESS_TOKEN/,
  /DUB_API_KEY/,
  /TINYBIRD_TOKEN/,
];

describe("no analytics in deploy files", () => {
  const files = getDeployFiles();

  it("finds the deploy files", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        "deploy/stack.yml",
        "deploy/stack.staging.yml",
        ".github/workflows/deploy.yml",
        ".github/workflows/deploy-staging.yml",
        "docker/Dockerfile.prod",
      ]),
    );
  });

  it.each(getDeployFiles())("%s sets no analytics key", (file) => {
    const content = readFileSync(join(REPO_ROOT, file), "utf8");
    const hits = ANALYTICS_KEYS.filter((key) => key.test(content)).map(String);

    expect(hits).toEqual([]);
  });
});

function getDeployFiles() {
  const deployDir = join(REPO_ROOT, "deploy");
  const workflowsDir = join(REPO_ROOT, ".github", "workflows");
  const stacks = existsSync(deployDir)
    ? readdirSync(deployDir)
        .filter((name) => /^stack.*\.ya?ml$/.test(name))
        .map((name) => `deploy/${name}`)
    : [];
  const workflows = readdirSync(workflowsDir)
    .filter((name) => /^deploy.*\.ya?ml$/.test(name))
    .map((name) => `.github/workflows/${name}`);

  return [...stacks, ...workflows, "docker/Dockerfile.prod"];
}
