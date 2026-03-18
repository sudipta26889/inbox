"use client";

import { useSearchParams } from "next/navigation";
import { useState, useMemo } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { MCP_SCOPES } from "@/utils/mcp-server/constants";
import { BRAND_NAME } from "@/utils/branding";

function decodeBase64Url(input: string): string {
  let base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4;
  if (pad === 2) base64 += "==";
  else if (pad === 3) base64 += "=";
  return atob(base64);
}

export default function ConsentContent() {
  const searchParams = useSearchParams();
  const [isLoading, setIsLoading] = useState(false);

  const params = useMemo(() => {
    const oauthState = searchParams.get("oauth_state");
    if (oauthState) {
      try {
        const decoded = decodeBase64Url(oauthState);
        return new URLSearchParams(decoded);
      } catch {
        return searchParams;
      }
    }
    return searchParams;
  }, [searchParams]);

  const clientName = params.get("client_name") || "Unknown Application";
  const clientLogoUri = params.get("client_logo_uri") || null;
  const scopeString = params.get("scope") || "";
  const scopes = scopeString.split(" ").filter(Boolean);

  const handleApprove = async () => {
    setIsLoading(true);
    try {
      const response = await fetch("/mcp-server/consent/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: params.get("client_id"),
          redirect_uri: params.get("redirect_uri"),
          scope: scopeString,
          state: params.get("state"),
          code_challenge: params.get("code_challenge"),
          code_challenge_method: params.get("code_challenge_method"),
          email_account_id: params.get("email_account_id"),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || data.message || "Authorization failed");
      }

      if (data.redirectUrl) {
        window.location.href = data.redirectUrl;
      } else {
        throw new Error("No redirect URL received");
      }
    } catch (error) {
      console.error("Failed to approve consent", error);
      alert("Failed to authorize application. Please try again.");
      setIsLoading(false);
    }
  };

  const handleDeny = () => {
    const redirectUri = params.get("redirect_uri");
    const state = params.get("state");

    if (redirectUri) {
      const redirectUrl = new URL(redirectUri);
      redirectUrl.searchParams.set("error", "access_denied");
      redirectUrl.searchParams.set("error_description", "User denied access");
      if (state) {
        redirectUrl.searchParams.set("state", state);
      }
      window.location.href = redirectUrl.toString();
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <Card className="max-w-md w-full p-6 space-y-6">
        <div className="text-center space-y-4">
          <div className="flex justify-center">
            {clientLogoUri ? (
              <Image
                src={clientLogoUri}
                alt={`${clientName} logo`}
                width={142}
                height={38}
                className="h-10 w-auto"
              />
            ) : (
              <Image
                src="/images/logos/email-agent-logo.png"
                alt={`${BRAND_NAME} logo`}
                width={142}
                height={38}
                className="h-10 w-auto"
              />
            )}
          </div>
          <h1 className="text-2xl font-bold">Authorize Access</h1>
          <p className="text-gray-600">
            <strong>{clientName}</strong> wants to access your {BRAND_NAME}{" "}
            account
          </p>
        </div>

        {scopes.length > 0 && (
          <div className="space-y-3">
            <h2 className="font-semibold text-sm text-gray-700">
              This application will be able to:
            </h2>
            <ul className="space-y-2">
              {scopes.map((scope) => {
                const scopeKey = scope as keyof typeof MCP_SCOPES;
                const description = MCP_SCOPES[scopeKey] || scope;
                return (
                  <li key={scope} className="flex items-start space-x-2">
                    <Checkbox checked disabled className="mt-1" />
                    <div className="flex-1">
                      <p className="text-sm font-medium">{description}</p>
                      <p className="text-xs text-gray-500">{scope}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className="border-t pt-4 space-y-2">
          <p className="text-xs text-gray-500">
            By authorizing, you allow {clientName} to use your information in
            accordance with their terms of service and privacy policy.
          </p>
          <p className="text-xs text-gray-500">
            You can revoke access at any time in your account settings.
          </p>
        </div>

        <div className="flex space-x-3">
          <Button
            variant="outline"
            className="flex-1"
            onClick={handleDeny}
            disabled={isLoading}
          >
            Deny
          </Button>
          <Button
            className="flex-1"
            onClick={handleApprove}
            disabled={isLoading}
          >
            {isLoading ? "Authorizing..." : "Authorize"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
