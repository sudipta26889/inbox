"use client";

import { useState } from "react";
import useSWR from "swr";
import { ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/Tooltip";
import { TaskpilotConvertModal } from "./TaskpilotConvertModal";
import type { TaskpilotStatusResponse } from "@/app/api/user/me/taskpilot-status/route";

interface Props {
  emailAccountId: string;
  messageId: string;
}

export function TaskpilotConvertButton({ emailAccountId, messageId }: Props) {
  const [open, setOpen] = useState(false);
  const { data: status } = useSWR<TaskpilotStatusResponse>(
    "/api/user/me/taskpilot-status",
  );

  if (!status?.configured) return null;

  return (
    <>
      <Tooltip content="Convert to TaskPilot task">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setOpen(true)}
          aria-label="Convert to TaskPilot task"
        >
          <ListChecks className="h-4 w-4" aria-hidden="true" />
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
