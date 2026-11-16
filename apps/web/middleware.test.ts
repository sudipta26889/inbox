import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { MCP_RESOURCE } from "@/utils/mcp-server/constants";
import { middleware } from "./middleware";

describe("OAuth discovery middleware", () => {
  it.each([
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp-server",
  ])("serves the protected-resource metadata at %s", async (path) => {
    const body = await (await middleware(request(path))).json();

    expect(body.resource).toBe(MCP_RESOURCE);
    expect(body).not.toHaveProperty("mcp_protocol_version");
  });

  it("advertises S256 only, public clients only, and client ID metadata documents", async () => {
    const body = await (
      await middleware(request("/.well-known/oauth-authorization-server"))
    ).json();

    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(body.client_id_metadata_document_supported).toBe(true);
    expect(body.authorization_response_iss_parameter_supported).toBe(true);
    expect(body.resource_indicators_supported).toBe(true);
  });
});

function request(path: string) {
  return new NextRequest(`http://localhost${path}`);
}
