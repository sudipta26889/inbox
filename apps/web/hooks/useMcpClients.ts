import useSWR from "swr";
import type { McpClientsResponse } from "@/app/api/user/mcp-clients/route";

export function useMcpClients() {
  return useSWR<McpClientsResponse>("/api/user/mcp-clients");
}
