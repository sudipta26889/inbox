"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";

interface Props {
  identifier: string;
  url: string;
}

export function TaskpilotBadge({ identifier, url }: Props) {
  return (
    <Link
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={`Open ${identifier} in TaskPilot`}
    >
      <Badge variant="secondary" className="font-mono text-[10px]">
        {identifier}
      </Badge>
    </Link>
  );
}
