"use client";

import { redirectToSafeUrl } from "@/utils/redirect";
import { useState } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { MCP_SCOPES } from "@/utils/mcp-server/constants";
import { BRAND_NAME } from "@/utils/branding";

type ConsentRequest = {
  client_id: string;
  redirect_uri: string;
  scope: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  email_account_id: string;
};

export default function ConsentContent({
  clientName,
  clientIdHost,
  logoUri: clientLogoUri,
  redirectHost,
  request,
}: {
  clientName: string;
  clientIdHost: string | null;
  logoUri: string | null;
  redirectHost: string;
  request: ConsentRequest;
}) {
  const [isLoading, setIsLoading] = useState(false);

  const scopeString = request.scope;
  const scopes = scopeString.split(" ").filter(Boolean);

  const submit = async (extra: { deny?: boolean }) => {
    setIsLoading(true);
    try {
      const response = await fetch("/mcp-server/consent/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...request, ...extra }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || data.message || "Authorization failed");
      }

      if (data.redirectUrl) {
        // The server only returns a redirect_uri registered by this OAuth client.
        redirectToSafeUrl(data.redirectUrl, {
          allowExternal: true,
          allowNativeOAuthRedirect: true,
        });
      } else {
        throw new Error("No redirect URL received");
      }
    } catch (error) {
      console.error("Failed to submit consent", error);
      alert("Something went wrong. Please try again.");
      setIsLoading(false);
    }
  };

  const handleApprove = () => submit({});
  const handleDeny = () => submit({ deny: true });

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <Card className="max-w-md w-full p-6 space-y-6">
        <div className="text-center space-y-4">
          <div className="flex justify-center">
            {clientLogoUri ? (
              // biome-ignore lint/performance/noImgElement: the logo is a client-supplied URL on any host, which next/image rejects
              <img
                src={clientLogoUri}
                alt=""
                referrerPolicy="no-referrer"
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
          {clientIdHost && (
            <p className="text-xs text-gray-500">Verified by {clientIdHost}</p>
          )}
          <p className="text-xs text-gray-500">
            After you choose, you will be sent to {redirectHost}
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
                const isAdmin = scope === "admin";
                return (
                  <li key={scope} className="flex items-start space-x-2">
                    <Checkbox checked disabled className="mt-1" />
                    <div className="flex-1">
                      <p
                        className={
                          isAdmin
                            ? "text-sm font-semibold text-amber-700"
                            : "text-sm font-medium"
                        }
                      >
                        {description}
                      </p>
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
