"use client";

import { useState } from "react";
import { useAction } from "next-safe-action/hooks";
import { Share2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { toastError, toastSuccess } from "@/components/Toast";
import {
  shareEmailAccountAction,
  unshareEmailAccountAction,
} from "@/utils/actions/email-account";
import { getActionErrorMessage } from "@/utils/error";

export function ShareAccountDialog({
  emailAccount,
  onChange,
}: {
  emailAccount: {
    id: string;
    email: string;
    sharedWith: { id: string; email: string; name: string | null }[];
  };
  onChange: () => void;
}) {
  const [email, setEmail] = useState("");

  const share = useAction(shareEmailAccountAction.bind(null, emailAccount.id), {
    onSuccess: () => {
      toastSuccess({ description: `Shared with ${email}` });
      setEmail("");
      onChange();
    },
    onError: (error) => {
      toastError({
        title: "Error sharing account",
        description: getActionErrorMessage(error.error),
      });
    },
  });

  const unshare = useAction(
    unshareEmailAccountAction.bind(null, emailAccount.id),
    {
      onSuccess: () => onChange(),
      onError: (error) => {
        toastError({
          title: "Error removing access",
          description: getActionErrorMessage(error.error),
        });
      },
    },
  );

  return (
    <Dialog>
      <DialogTrigger asChild>
        <DropdownMenuItem
          // Keep the menu mounted, or the dialog unmounts with it.
          onSelect={(e) => e.preventDefault()}
          className="flex items-center gap-2"
        >
          <Share2 className="size-4" />
          Share
        </DropdownMenuItem>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share {emailAccount.email}</DialogTitle>
          <DialogDescription>
            People you share with get full access to this account from their own
            login. They must have signed in at least once.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            share.execute({ email });
          }}
        >
          <Input
            type="email"
            placeholder="their-login@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <Button type="submit" loading={share.isExecuting}>
            Share
          </Button>
        </form>

        {emailAccount.sharedWith.length > 0 && (
          <ul className="divide-y rounded-md border">
            {emailAccount.sharedWith.map((user) => (
              <li
                key={user.id}
                className="flex items-center justify-between px-3 py-2 text-sm"
              >
                <span>
                  {user.name ? `${user.name} · ` : ""}
                  {user.email}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove access for ${user.email}`}
                  disabled={unshare.isExecuting}
                  onClick={() => unshare.execute({ userId: user.id })}
                >
                  <X className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
