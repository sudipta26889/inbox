"use client";

import Link from "next/link";
import { Button } from "@/components/new-landing/common/Button";
import { Chat } from "@/components/new-landing/icons/Chat";
import { cn } from "@/utils";

interface CallToActionProps {
  buttonSize?: "xl" | "lg";
  className?: string;
  showSalesButton?: boolean;
  text?: string;
}

export function CallToAction({
  text = "Get started",
  buttonSize = "xl",
  className,
  showSalesButton = true,
}: CallToActionProps) {
  return (
    <div className={cn("flex justify-center items-center gap-4", className)}>
      <Button size={buttonSize} asChild>
        <Link href="/login">
          <span className="relative z-10">{text}</span>
        </Link>
      </Button>
      {showSalesButton ? (
        <Button variant="secondary-two" size={buttonSize} asChild>
          <Link href="/sales" target="_blank">
            <Chat />
            Talk to sales
          </Link>
        </Button>
      ) : null}
    </div>
  );
}
