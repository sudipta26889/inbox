"use client";

import { useState } from "react";
import { PlusIcon, CopyIcon, TrashIcon } from "lucide-react";
import useSWR from "swr";
import {
  Item,
  ItemActions,
  ItemCard,
  ItemContent,
  ItemDescription,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { LoadingContent } from "@/components/LoadingContent";
import { toastSuccess, toastError } from "@/components/Toast";
import type { GetA2aClientsResponse } from "@/app/api/user/a2a-clients/route";
import { env } from "@/env";

export function A2aClientsSection() {
  const { data, isLoading, error, mutate } = useSWR<GetA2aClientsResponse>(
    "/api/user/a2a-clients",
  );
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [createdClient, setCreatedClient] = useState<any>(null);

  return (
    <ItemCard>
      <Item>
        <ItemContent>
          <ItemTitle>A2A Protocol Clients</ItemTitle>
          <ItemDescription>
            Create OAuth clients for external AI agents to access your email and
            calendar via the A2A protocol.
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button
            onClick={() => setIsCreateDialogOpen(true)}
            size="sm"
            variant="outline"
          >
            <PlusIcon className="mr-2 h-4 w-4" />
            New Client
          </Button>
        </ItemActions>
      </Item>

      <LoadingContent loading={isLoading} error={error}>
        {data?.clients && data.clients.length > 0 ? (
          <>
            <ItemSeparator />
            <div className="space-y-2 p-4">
              {data.clients.map((client) => (
                <ClientItem
                  key={client.id}
                  client={client}
                  onDelete={() => mutate()}
                />
              ))}
            </div>
          </>
        ) : (
          <ItemSeparator />
        )}
      </LoadingContent>

      {data?.clients && data.clients.length === 0 && (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          No A2A clients yet. Create one to allow external agents to access your
          data.
        </div>
      )}

      <CreateClientDialog
        open={isCreateDialogOpen}
        onOpenChange={setIsCreateDialogOpen}
        onCreated={(client) => {
          setCreatedClient(client);
          mutate();
        }}
      />

      <ClientCreatedDialog
        client={createdClient}
        onClose={() => setCreatedClient(null)}
      />
    </ItemCard>
  );
}

function ClientItem({
  client,
  onDelete,
}: {
  client: GetA2aClientsResponse["clients"][number];
  onDelete: () => void;
}) {
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async () => {
    if (
      !confirm(
        `Delete "${client.clientName}"? This will revoke all access tokens.`,
      )
    ) {
      return;
    }

    setIsDeleting(true);
    try {
      const res = await fetch("/api/user/a2a-clients", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientIds: [client.clientId] }),
      });

      if (!res.ok) {
        throw new Error("Failed to delete client");
      }

      toastSuccess({ description: "Client deleted successfully" });
      onDelete();
    } catch (error) {
      toastError({ description: "Failed to delete client" });
    } finally {
      setIsDeleting(false);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toastSuccess({ description: `${label} copied to clipboard` });
  };

  return (
    <div className="rounded-lg border p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="font-medium text-sm truncate">
              {client.clientName}
            </h4>
            {client.activeTokenCount > 0 && (
              <Badge variant="secondary" className="text-xs">
                {client.activeTokenCount} active token
                {client.activeTokenCount !== 1 ? "s" : ""}
              </Badge>
            )}
          </div>
          {client.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
              {client.description}
            </p>
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={handleDelete}
          disabled={isDeleting}
        >
          <TrashIcon className="h-4 w-4" />
        </Button>
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <code className="flex-1 text-xs bg-muted px-2 py-1 rounded truncate">
            {client.clientId}
          </code>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => copyToClipboard(client.clientId, "Client ID")}
          >
            <CopyIcon className="h-3 w-3" />
          </Button>
        </div>

        {client.lastUsedAt && (
          <p className="text-xs text-muted-foreground">
            Last used: {new Date(client.lastUsedAt).toLocaleString()}
          </p>
        )}
      </div>
    </div>
  );
}

function CreateClientDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (client: any) => void;
}) {
  const [isCreating, setIsCreating] = useState(false);
  const [formData, setFormData] = useState({
    clientName: "",
    description: "",
    redirectUris: "",
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const redirectUrisArray = formData.redirectUris
      .split("\n")
      .map((uri) => uri.trim())
      .filter((uri) => uri.length > 0);

    if (redirectUrisArray.length === 0) {
      toastError({ description: "At least one redirect URI is required" });
      return;
    }

    setIsCreating(true);
    try {
      const res = await fetch("/api/user/a2a-clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName: formData.clientName,
          description: formData.description || undefined,
          redirectUris: redirectUrisArray,
        }),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to create client");
      }

      const result = await res.json();
      toastSuccess({ description: "Client created successfully" });
      onCreated(result.client);
      onOpenChange(false);

      // Reset form
      setFormData({
        clientName: "",
        description: "",
        redirectUris: "",
      });
    } catch (error: any) {
      toastError({ description: `Failed to create client: ${error.message}` });
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create A2A OAuth Client</DialogTitle>
          <DialogDescription>
            Create a new OAuth client for external AI agents to access your data
            via the A2A protocol.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="clientName">Client Name *</Label>
            <Input
              id="clientName"
              placeholder="My AI Agent"
              value={formData.clientName}
              onChange={(e) =>
                setFormData({ ...formData, clientName: e.target.value })
              }
              required
              maxLength={100}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description (optional)</Label>
            <Textarea
              id="description"
              placeholder="Brief description of this client"
              value={formData.description}
              onChange={(e) =>
                setFormData({ ...formData, description: e.target.value })
              }
              maxLength={500}
              rows={2}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="redirectUris">Redirect URIs *</Label>
            <Textarea
              id="redirectUris"
              placeholder="https://example.com/oauth/callback&#10;http://localhost:3000/callback"
              value={formData.redirectUris}
              onChange={(e) =>
                setFormData({ ...formData, redirectUris: e.target.value })
              }
              required
              rows={3}
            />
            <p className="text-xs text-muted-foreground">
              One URI per line. Maximum 10 URIs.
            </p>
          </div>

          <div className="rounded-lg bg-muted p-3 space-y-2">
            <h4 className="text-sm font-medium">Agent Discovery</h4>
            <p className="text-xs text-muted-foreground">
              Your AgentCard is available at:
            </p>
            <code className="block text-xs bg-background px-2 py-1 rounded break-all">
              {env.NEXT_PUBLIC_BASE_URL}/.well-known/agent-card.json
            </code>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isCreating}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isCreating}>
              {isCreating ? "Creating..." : "Create Client"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ClientCreatedDialog({
  client,
  onClose,
}: {
  client: any;
  onClose: () => void;
}) {
  if (!client) return null;

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toastSuccess({ description: `${label} copied to clipboard` });
  };

  return (
    <Dialog open={!!client} onOpenChange={() => onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Client Created Successfully</DialogTitle>
          <DialogDescription>
            Save your client credentials now. The client secret will not be
            shown again.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Client ID</Label>
            <div className="flex gap-2">
              <code className="flex-1 text-sm bg-muted px-3 py-2 rounded break-all">
                {client.clientId}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => copyToClipboard(client.clientId, "Client ID")}
              >
                <CopyIcon className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Client Secret</Label>
            <div className="flex gap-2">
              <code className="flex-1 text-sm bg-muted px-3 py-2 rounded break-all">
                {client.clientSecret}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  copyToClipboard(client.clientSecret, "Client Secret")
                }
              >
                <CopyIcon className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="rounded-lg bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 p-3">
            <p className="text-sm text-amber-900 dark:text-amber-100">
              ⚠️ <strong>Important:</strong> Save the client secret securely. You
              won't be able to see it again.
            </p>
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-medium">OAuth Configuration</h4>
            <div className="space-y-1 text-xs">
              <p>
                <strong>Authorization URL:</strong>
              </p>
              <code className="block bg-muted px-2 py-1 rounded break-all">
                {env.NEXT_PUBLIC_BASE_URL}/mcp-server/authorize
              </code>
            </div>
            <div className="space-y-1 text-xs">
              <p>
                <strong>Token URL:</strong>
              </p>
              <code className="block bg-muted px-2 py-1 rounded break-all">
                {env.NEXT_PUBLIC_BASE_URL}/mcp-server/token
              </code>
            </div>
            <div className="space-y-1 text-xs">
              <p>
                <strong>A2A Endpoint:</strong>
              </p>
              <code className="block bg-muted px-2 py-1 rounded break-all">
                {env.NEXT_PUBLIC_BASE_URL}/a2a
              </code>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
