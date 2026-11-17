import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// `next build` fails on a route file that exports anything but HTTP handlers
// and route config. It only shows up in a production build, so it is checked
// here. Types are erased and do not count.
const APP_ROOT = join(import.meta.dirname, "..", "app");

const ALLOWED_ROUTE_EXPORTS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "dynamic",
  "dynamicParams",
  "revalidate",
  "fetchCache",
  "runtime",
  "preferredRegion",
  "maxDuration",
  "generateStaticParams",
]);

const ALLOWED_PAGE_EXPORTS = new Set([
  "default",
  "dynamic",
  "dynamicParams",
  "revalidate",
  "fetchCache",
  "runtime",
  "preferredRegion",
  "maxDuration",
  "metadata",
  "viewport",
  "generateMetadata",
  "generateViewport",
  "generateStaticParams",
]);

describe("Next route and page files export only what Next allows", () => {
  it("route.ts exports only HTTP methods and route config", () => {
    expect(offenders(/^route\.ts$/, ALLOWED_ROUTE_EXPORTS)).toEqual([]);
  });

  it("page.tsx and layout.tsx export only a component and page config", () => {
    expect(offenders(/^(page|layout)\.tsx$/, ALLOWED_PAGE_EXPORTS)).toEqual([]);
  });
});

function offenders(fileName: RegExp, allowed: Set<string>) {
  return listFiles(APP_ROOT, fileName).flatMap((file) =>
    valueExports(readFileSync(file, "utf8"))
      .filter((name) => !allowed.has(name))
      .map((name) => `${relative(APP_ROOT, file)}: ${name}`),
  );
}

// Names of exported values: functions, classes, consts (including a destructured
// `export const { GET } = ...`), lets and vars, and `export { a, b }`.
function valueExports(source: string): string[] {
  const names: string[] = [];

  for (const match of source.matchAll(
    /^export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))/gm,
  )) {
    if (match[1]) {
      names.push(
        ...match[1]
          .split(",")
          .map((part) => part.split(":").pop()?.trim() ?? "")
          .filter(Boolean),
      );
    } else if (match[2]) {
      names.push(match[2]);
    }
  }

  for (const match of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    names.push(
      ...match[1]
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part && !part.startsWith("type "))
        .map((part) => part.split(/\s+as\s+/).pop() ?? part),
    );
  }

  if (/^export\s+default\b/m.test(source)) names.push("default");

  return names;
}

function listFiles(dir: string, fileName: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "node_modules" ? [] : listFiles(path, fileName);
    }
    return fileName.test(name) ? [path] : [];
  });
}
