import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

// With no billing, agents asking for Markdown get the HTML pages, not the
// upstream plan and pricing text.
vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS: true,
    NEXT_PUBLIC_BRAND_NAME: "Inbox",
    NEXT_PUBLIC_BASE_URL: "https://inbox.example.com",
  },
}));

import { proxy } from "./proxy";

describe("proxy with premium checks bypassed", () => {
  it.each(["/", "/pricing"])("serves no agent Markdown for %s", (path) => {
    const response = proxy(
      new NextRequest(`https://inbox.example.com${path}`, {
        headers: { Accept: "text/markdown" },
      }),
    );

    expect(response.headers.get("content-type") ?? "").not.toContain(
      "text/markdown",
    );
  });
});
