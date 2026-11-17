import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Portainer refuses to clone a repository that tracks symlinks, so a symlink
// on the production branch silently stops every deploy.
describe("repository", () => {
  it("tracks no symlinks", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const symlinks = execFileSync("git", ["ls-files", "-s"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split("\n")
      .filter((line) => line.startsWith("120000 "))
      .map((line) => line.split("\t")[1]);

    expect(symlinks).toEqual([]);
  });
});
