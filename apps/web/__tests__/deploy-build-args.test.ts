import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Docker silently drops a build arg the Dockerfile does not declare, so a
// NEXT_PUBLIC_* flag set in a deploy workflow would never reach the bundle.
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const dockerfile = readFileSync(
  join(REPO_ROOT, "docker/Dockerfile.prod"),
  "utf8",
);

describe.each([
  ".github/workflows/deploy.yml",
  ".github/workflows/deploy-staging.yml",
])("%s build args", (workflow) => {
  const content = readFileSync(join(REPO_ROOT, workflow), "utf8");
  const args = [
    ...content.matchAll(/^\s+((?:NEXT_PUBLIC_|GIT_SHA)\w*)=/gm),
  ].map((match) => match[1]);

  it("sets some", () => {
    expect(args.length).toBeGreaterThan(5);
  });

  it.each(args)("%s is declared in Dockerfile.prod", (arg) => {
    expect(dockerfile).toMatch(new RegExp(`^ARG ${arg}\\b`, "m"));
  });
});
