"use client";

import { useState } from "react";
import Image from "next/image";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemActions,
} from "@/components/ui/item";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useMcpClients } from "@/hooks/useMcpClients";
import { LoadingContent } from "@/components/LoadingContent";
import { toastError, toastSuccess } from "@/components/Toast";

export function McpClientsSection() {
  const { data, isLoading, error, mutate } = useMcpClients();
  const [revokingClientId, setRevokingClientId] = useState<string | null>(null);

  const clientCount = data?.mcpClients.length ?? 0;

  const handleRevoke = async (clientId: string) => {
    try {
      setRevokingClientId(clientId);
      const response = await fetch("/api/user/mcp-clients", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ clientIds: [clientId] }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Failed to revoke access");
      }

      toastSuccess({ description: "Access revoked" });
      mutate();
    } catch (error) {
      console.error("Failed to revoke MCP client:", error);
      toastError({
        description:
          error instanceof Error
            ? error.message
            : "Failed to revoke access. Please try again.",
      });
    } finally {
      setRevokingClientId(null);
    }
  };

  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle>MCP Clients</ItemTitle>
      </ItemContent>
      <ItemActions>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">
              View clients{clientCount > 0 ? ` (${clientCount})` : ""}
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>MCP Clients</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Applications you have authorized to access your account. Revoking
              ends their access right away; they must be authorized again to
              reconnect.
            </p>
            <LoadingContent loading={isLoading} error={error}>
              {clientCount > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Client</TableHead>
                      <TableHead>Host</TableHead>
                      <TableHead>Last used</TableHead>
                      <TableHead className="w-24" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data?.mcpClients.map((client) => (
                      <TableRow key={client.clientId}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {client.logoUri && (
                              <Image
                                src={client.logoUri}
                                alt={client.clientName}
                                width={20}
                                height={20}
                                // The logo comes from a client-supplied URL, so
                                // it can't be on next/image's host allow-list.
                                unoptimized
                                className="size-5 rounded"
                              />
                            )}
                            <span className="font-medium">
                              {client.clientName}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <code className="text-xs text-muted-foreground">
                            {client.host || "unknown"}
                          </code>
                        </TableCell>
                        <TableCell>
                          {client.lastUsedAt
                            ? new Date(client.lastUsedAt).toLocaleString()
                            : "Never"}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="destructive"
                            size="sm"
                            className="text-xs"
                            disabled={revokingClientId === client.clientId}
                            onClick={() => handleRevoke(client.clientId)}
                          >
                            Revoke
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No MCP clients yet.
                </p>
              )}
            </LoadingContent>
          </DialogContent>
        </Dialog>
      </ItemActions>
    </Item>
  );
}
