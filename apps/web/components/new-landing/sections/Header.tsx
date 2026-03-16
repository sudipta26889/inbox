"use client";

import Link from "next/link";
import { cn } from "@/utils";
import { Logo } from "@/components/new-landing/common/Logo";
import { Button } from "@/components/new-landing/common/Button";

interface HeaderProps {
  className: string;
}

export function Header({ className }: HeaderProps) {
  return (
    <header
      className={cn(
        "bg-white mx-auto flex items-center justify-between h-16",
        className,
      )}
    >
      <div className="hidden md:block">
        <Logo />
      </div>
      <div className="block md:hidden">
        <Logo variant="mobile" />
      </div>
      <div className="flex items-center gap-3">
        <Button asChild>
          <Link href="/login">
            <span className="relative z-10">Sign in</span>
          </Link>
        </Button>
      </div>
    </header>
  );
}
