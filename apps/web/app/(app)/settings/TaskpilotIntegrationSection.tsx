"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { useAction } from "next-safe-action/hooks";
import useSWR from "swr";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/Input";
import { Badge } from "@/components/ui/badge";
import { LoadingContent } from "@/components/LoadingContent";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { toastError, toastSuccess } from "@/components/Toast";
import {
  testTaskpilotConnectionAction,
  updateTaskpilotIntegrationAction,
} from "@/utils/actions/taskpilot";
import { getActionErrorMessage } from "@/utils/error";
import type { TaskpilotStatusResponse } from "@/app/api/user/me/taskpilot-status/route";

const formSchema = z.object({
  workspaceSlug: z
    .string()
    .min(1, "Required")
    .max(100)
    .regex(/^[a-z0-9-]+$/i, "letters, digits, dashes only"),
  apiKey: z.string().min(1, "Required"),
});

type FormValues = z.infer<typeof formSchema>;

const STATUS_KEY = "/api/user/me/taskpilot-status";

export function TaskpilotIntegrationSection() {
  const {
    data: status,
    mutate,
    isLoading,
  } = useSWR<TaskpilotStatusResponse>(STATUS_KEY);
  const [editing, setEditing] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { workspaceSlug: "", apiKey: "" },
  });

  const update = useAction(updateTaskpilotIntegrationAction, {
    onSuccess: () => {
      toastSuccess({ description: "TaskPilot integration updated" });
      mutate();
      setEditing(false);
      form.reset({ workspaceSlug: "", apiKey: "" });
    },
    onError: (error) => {
      toastError({
        description: getActionErrorMessage(error.error, {
          prefix: "Failed to update TaskPilot integration",
        }),
      });
    },
  });

  const test = useAction(testTaskpilotConnectionAction, {
    onSuccess: (result) => {
      if (result?.data?.ok) {
        toastSuccess({
          description: `OK — ${result.data.projectCount} project${result.data.projectCount === 1 ? "" : "s"} reachable`,
        });
      }
    },
    onError: (error) => {
      toastError({
        description: getActionErrorMessage(error.error, {
          prefix: "TaskPilot connection failed",
        }),
      });
    },
  });

  const onSubmit = (values: FormValues) => {
    update.execute({
      apiKey: values.apiKey,
      workspaceSlug: values.workspaceSlug,
    });
  };

  const onClear = () => {
    update.execute({ apiKey: null, workspaceSlug: null });
  };

  return (
    <Item size="sm" className="flex-col items-stretch gap-3">
      <div className="flex items-center justify-between gap-3">
        <ItemContent>
          <ItemTitle>TaskPilot</ItemTitle>
          <ItemDescription>
            Convert emails into TaskPilot work items via a service token. The
            token is encrypted at rest and never returned by the API.
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          {status?.configured ? (
            <Badge variant="default">Connected</Badge>
          ) : (
            <Badge variant="outline">Not configured</Badge>
          )}
        </ItemActions>
      </div>

      <LoadingContent loading={isLoading}>
        {status?.configured && !editing ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Workspace:</span>
            <span className="font-mono">{status.workspaceSlug}</span>
            <span className="ml-auto flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => test.execute()}
                disabled={test.isExecuting}
              >
                {test.isExecuting ? "Testing…" : "Test connection"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  form.reset({
                    workspaceSlug: status.workspaceSlug ?? "",
                    apiKey: "",
                  });
                  setEditing(true);
                }}
              >
                Replace
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={onClear}
                disabled={update.isExecuting}
              >
                Clear
              </Button>
            </span>
          </div>
        ) : (
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-2">
            <Input
              type="text"
              name="workspaceSlug"
              label="Workspace slug"
              placeholder="acme"
              registerProps={form.register("workspaceSlug")}
              error={form.formState.errors.workspaceSlug}
            />
            <Input
              type="password"
              name="apiKey"
              label="API key"
              placeholder={
                status?.configured
                  ? "Paste new token to replace"
                  : "Paste service token"
              }
              registerProps={form.register("apiKey")}
              error={form.formState.errors.apiKey}
            />
            <p className="text-xs text-muted-foreground">
              Generate a service token in TaskPilot → workspace settings → API
              tokens. Service tokens get 300 req/min.
            </p>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={update.isExecuting}>
                {update.isExecuting ? "Saving…" : "Save"}
              </Button>
              {editing && status?.configured && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditing(false);
                    form.reset({ workspaceSlug: "", apiKey: "" });
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
          </form>
        )}
      </LoadingContent>
    </Item>
  );
}
