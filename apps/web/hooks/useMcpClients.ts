import useSWR from "swr";
import type { McpServerClient } from "@/generated/prisma/client";

export type McpClient = Pick<
  McpServerClient,
  "id" | "clientId" | "clientName" | "logoUri" | "createdAt" | "updatedAt"
> & {
  _count: {
    accessTokens: number;
  };
};

export type McpClientsResponse = {
  mcpClients: McpClient[];
};

export function useMcpClients() {
  return useSWR<McpClientsResponse>("/api/user/mcp-clients");
}
