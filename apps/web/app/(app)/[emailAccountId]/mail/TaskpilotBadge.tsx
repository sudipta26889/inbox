"use client";

import type { MouseEvent } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";

export function TaskpilotBadge({
  identifier,
  url,
}: {
  identifier: string;
  url: string;
}) {
  return (
    <Link
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e: MouseEvent) => e.stopPropagation()}
      title={`Open ${identifier} in TaskPilot`}
    >
      <Badge variant="secondary" className="font-mono text-[10px]">
        {identifier}
      </Badge>
    </Link>
  );
}
