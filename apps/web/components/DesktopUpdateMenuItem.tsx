"use client";

import { Trans, useLingui } from "@lingui/react/macro";
import { DownloadIcon } from "lucide-react";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useDesktopUpdateStatus } from "@/hooks/useDesktopUpdateStatus";
import { getInboxZeroDesktopApp } from "@/utils/desktop-app";
import { SHOW_UPSTREAM_PROMOS } from "@/utils/upstream-promos";

// The desktop app is not shipped here.
export function DesktopUpdateMenuItem() {
  if (!SHOW_UPSTREAM_PROMOS) return null;

  return <DesktopUpdateButton />;
}

function DesktopUpdateButton() {
  const { t } = useLingui();
  const status = useDesktopUpdateStatus();
  if (status?.state !== "ready") return null;
  return (
    <SidebarMenu>
      <SidebarMenuItem className="font-semibold">
        <SidebarMenuButton
          className="h-9"
          tooltip={t`Restart to update`}
          sidebarName="left-sidebar"
          onClick={() => getInboxZeroDesktopApp()?.installUpdate?.()}
        >
          <DownloadIcon />
          <span>
            <Trans>Restart to update</Trans>
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
