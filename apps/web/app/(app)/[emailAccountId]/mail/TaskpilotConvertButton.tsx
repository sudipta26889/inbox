"use client";

import { useState } from "react";
import useSWR from "swr";
import { ListChecksIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/Tooltip";
import { TaskpilotConvertModal } from "@/app/(app)/[emailAccountId]/mail/TaskpilotConvertModal";
import type { TaskpilotStatusResponse } from "@/app/api/user/me/taskpilot-status/route";

export function TaskpilotConvertButton({
  emailAccountId,
  messageId,
}: {
  emailAccountId: string;
  messageId: string;
}) {
  const [open, setOpen] = useState(false);
  const { data: status } = useSWR<TaskpilotStatusResponse>(
    "/api/user/me/taskpilot-status",
  );

  if (!status?.configured) return null;

  return (
    <>
      <Tooltip content="Convert to TaskPilot task">
        <Button
          aria-label="Convert to TaskPilot task"
          size="iconXs"
          variant="ghost"
          onClick={() => setOpen(true)}
        >
          <ListChecksIcon className="size-3.5" aria-hidden="true" />
        </Button>
      </Tooltip>
      <TaskpilotConvertModal
        emailAccountId={emailAccountId}
        messageId={messageId}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
