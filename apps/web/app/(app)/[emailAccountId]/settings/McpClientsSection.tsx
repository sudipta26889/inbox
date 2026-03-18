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
import { Checkbox } from "@/components/ui/checkbox";
import { useMcpClients } from "@/hooks/useMcpClients";
import { LoadingContent } from "@/components/LoadingContent";
import { useAccount } from "@/providers/EmailAccountProvider";
import { toastError, toastSuccess } from "@/components/Toast";

export function McpClientsSection() {
  const { emailAccountId } = useAccount();
  const { data, isLoading, error, mutate } = useMcpClients();
  const [selectedClientIds, setSelectedClientIds] = useState<Set<string>>(
    new Set(),
  );
  const [isDeleting, setIsDeleting] = useState(false);

  const clientCount = data?.mcpClients.length ?? 0;
  const allClientIds = data?.mcpClients.map((c) => c.clientId) ?? [];

  const toggleClient = (clientId: string) => {
    setSelectedClientIds((prev) => {
      const next = new Set(prev);
      if (next.has(clientId)) {
        next.delete(clientId);
      } else {
        next.add(clientId);
      }
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedClientIds.size === clientCount) {
      setSelectedClientIds(new Set());
    } else {
      setSelectedClientIds(new Set(allClientIds));
    }
  };

  const handleDelete = async () => {
    if (selectedClientIds.size === 0) return;

    try {
      setIsDeleting(true);
      const response = await fetch("/api/user/mcp-clients", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clientIds: Array.from(selectedClientIds),
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Failed to delete MCP clients");
      }

      toastSuccess({
        description: `Deleted ${result.deleted} MCP client${result.deleted !== 1 ? "s" : ""}`,
      });

      setSelectedClientIds(new Set());
      mutate();
    } catch (error) {
      console.error("Failed to delete MCP clients:", error);
      toastError({
        description:
          error instanceof Error
            ? error.message
            : "Failed to delete MCP clients. Please try again.",
      });
    } finally {
      setIsDeleting(false);
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
              Manage MCP clients that have been authorized to access your
              account.
            </p>
            <LoadingContent loading={isLoading} error={error}>
              {clientCount > 0 ? (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={toggleAll}
                      className="text-xs"
                    >
                      {selectedClientIds.size === clientCount
                        ? "Deselect all"
                        : "Select all"}
                    </Button>
                    {selectedClientIds.size > 0 && (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={handleDelete}
                        disabled={isDeleting}
                        className="text-xs"
                      >
                        Delete {selectedClientIds.size} client
                        {selectedClientIds.size !== 1 ? "s" : ""}
                      </Button>
                    )}
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-12" />
                        <TableHead>Client</TableHead>
                        <TableHead>Client ID</TableHead>
                        <TableHead>Tokens</TableHead>
                        <TableHead>Created</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data?.mcpClients.map((client) => (
                        <TableRow key={client.id}>
                          <TableCell>
                            <Checkbox
                              checked={selectedClientIds.has(client.clientId)}
                              onCheckedChange={() =>
                                toggleClient(client.clientId)
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              {client.logoUri && (
                                <Image
                                  src={client.logoUri}
                                  alt={client.clientName}
                                  width={20}
                                  height={20}
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
                              {client.clientId}
                            </code>
                          </TableCell>
                          <TableCell>{client._count.accessTokens}</TableCell>
                          <TableCell>
                            {new Date(client.createdAt).toLocaleString()}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </>
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
