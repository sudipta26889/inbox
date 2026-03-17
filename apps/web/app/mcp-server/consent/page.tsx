"use client";

import dynamic from "next/dynamic";

const ConsentContent = dynamic(() => import("./consent-content"), {
  ssr: false,
  loading: () => (
    <div className="min-h-screen flex items-center justify-center">
      Loading...
    </div>
  ),
});

/**
 * OAuth 2.1 Consent Screen Page
 *
 * This page shows users what permissions an MCP client is requesting
 * and allows them to approve or deny access.
 */
export default function McpConsentPage() {
  return <ConsentContent />;
}
