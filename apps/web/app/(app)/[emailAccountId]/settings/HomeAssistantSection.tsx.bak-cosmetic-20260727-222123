"use client";

import { useState } from "react";
import { HomeIcon } from "lucide-react";
import { useUser } from "@/hooks/useUser";
import { LoadingContent } from "@/components/LoadingContent";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from "@/components/ui/item";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toastError, toastSuccess } from "@/components/Toast";

export function HomeAssistantSection() {
  const { data, isLoading, error, mutate } = useUser();
  const [isOpen, setIsOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [homeAssistantUrl, setHomeAssistantUrl] = useState("");
  const [homeAssistantToken, setHomeAssistantToken] = useState("");

  const hasExistingConfig = !!(
    data?.homeAssistantUrl && data?.homeAssistantToken
  );

  const handleOpen = (open: boolean) => {
    if (open && data) {
      setHomeAssistantUrl(data.homeAssistantUrl || "");
      setHomeAssistantToken(data.homeAssistantToken || "");
    }
    setIsOpen(open);
  };

  const handleSave = async () => {
    if (!homeAssistantUrl.trim()) {
      toastError({ description: "Home Assistant URL is required" });
      return;
    }

    // Validate URL format
    try {
      const url = new URL(homeAssistantUrl.trim());
      if (!url.protocol.startsWith("http")) {
        toastError({ description: "URL must start with http:// or https://" });
        return;
      }
    } catch {
      toastError({ description: "Invalid URL format" });
      return;
    }

    if (!homeAssistantToken.trim()) {
      toastError({ description: "Access token is required" });
      return;
    }

    setIsSaving(true);

    try {
      const response = await fetch("/api/user/settings/home-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          homeAssistantUrl: homeAssistantUrl.trim(),
          homeAssistantToken: homeAssistantToken.trim(),
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to save settings");
      }

      toastSuccess({
        description: "Home Assistant settings saved successfully",
      });
      await mutate();
      setIsOpen(false);
    } catch (error) {
      console.error("Error saving Home Assistant settings:", error);
      toastError({
        description:
          error instanceof Error
            ? error.message
            : "Failed to save Home Assistant settings",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm("Are you sure you want to disconnect Home Assistant?")) {
      return;
    }

    setIsSaving(true);

    try {
      const response = await fetch("/api/user/settings/home-assistant", {
        method: "DELETE",
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to disconnect");
      }

      toastSuccess({ description: "Home Assistant disconnected successfully" });
      await mutate();
      setIsOpen(false);
    } catch (error) {
      console.error("Error disconnecting Home Assistant:", error);
      toastError({
        description:
          error instanceof Error
            ? error.message
            : "Failed to disconnect Home Assistant",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle className="flex items-center gap-2">
          <HomeIcon className="size-4" />
          Home Assistant
        </ItemTitle>
        <ItemDescription>
          Connect your Home Assistant instance to trigger automations, publish
          to MQTT, and control devices based on email rules.
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Dialog open={isOpen} onOpenChange={handleOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">
              {hasExistingConfig ? "Manage" : "Connect"}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Home Assistant Integration</DialogTitle>
              <DialogDescription>
                Configure your Home Assistant connection to enable automation
                triggers from email rules.
              </DialogDescription>
            </DialogHeader>
            <LoadingContent loading={isLoading} error={error}>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="ha-url">Home Assistant URL</Label>
                  <Input
                    id="ha-url"
                    type="url"
                    placeholder="https://homeassistant.local:8123"
                    value={homeAssistantUrl}
                    onChange={(e) => setHomeAssistantUrl(e.target.value)}
                    disabled={isSaving}
                  />
                  <p className="text-xs text-muted-foreground">
                    Your Home Assistant instance URL (including http:// or
                    https://)
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="ha-token">Long-Lived Access Token</Label>
                  <Input
                    id="ha-token"
                    type="password"
                    placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                    value={homeAssistantToken}
                    onChange={(e) => setHomeAssistantToken(e.target.value)}
                    disabled={isSaving}
                  />
                  <p className="text-xs text-muted-foreground">
                    Create this in Home Assistant: Profile → Long-Lived Access
                    Tokens → Create Token
                  </p>
                </div>

                <div className="flex gap-2 pt-4">
                  <Button
                    onClick={handleSave}
                    disabled={isSaving}
                    className="flex-1"
                  >
                    {isSaving ? "Saving..." : "Save"}
                  </Button>
                  {hasExistingConfig && (
                    <Button
                      onClick={handleDisconnect}
                      disabled={isSaving}
                      variant="destructive"
                    >
                      Disconnect
                    </Button>
                  )}
                </div>
              </div>
            </LoadingContent>
          </DialogContent>
        </Dialog>
      </ItemActions>
    </Item>
  );
}
