"use client";

import { useEffect, useState } from "react";
import { useAction } from "next-safe-action/hooks";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LoadingContent } from "@/components/LoadingContent";
import { toastError, toastSuccess } from "@/components/Toast";
import {
  commitTaskpilotTaskAction,
  convertEmailToTaskpilotTaskDraftAction,
} from "@/utils/actions/taskpilot";
import { getActionErrorMessage } from "@/utils/error";

type Priority = "urgent" | "high" | "medium" | "low" | "none";

interface FormState {
  description_html: string;
  labelNames: string[];
  priority: Priority;
  projectId: string;
  targetDate?: string;
  title: string;
}

interface Props {
  emailAccountId: string;
  messageId: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

export function TaskpilotConvertModal({
  emailAccountId,
  messageId,
  open,
  onOpenChange,
}: Props) {
  const [form, setForm] = useState<FormState | null>(null);
  const [projects, setProjects] = useState<
    Array<{ id: string; identifier: string; name: string }>
  >([]);
  const [labelsByProject, setLabelsByProject] = useState<
    Record<string, Array<{ id: string; name: string }>>
  >({});
  const [draftError, setDraftError] = useState<string | null>(null);

  const draft = useAction(
    convertEmailToTaskpilotTaskDraftAction.bind(null, emailAccountId),
    {
      onSuccess: ({ data }) => {
        if (!data) return;
        if (data.alreadyExisted && data.link) {
          toastSuccess({
            description: `Already linked to ${data.link.taskpilotIdentifier}`,
          });
          onOpenChange(false);
          return;
        }
        if (data.draft) {
          setForm({
            projectId: data.draft.projectId,
            title: data.draft.title,
            description_html: data.draft.description_html,
            priority: data.draft.priority,
            labelNames: data.draft.labelNames,
            targetDate: data.draft.targetDate,
          });
          setProjects(data.projects ?? []);
          setLabelsByProject(data.labelsByProject ?? {});
        }
      },
      onError: (error) => {
        setDraftError(
          getActionErrorMessage(error.error, {
            prefix: "Failed to draft task",
          }),
        );
      },
    },
  );

  const commit = useAction(
    commitTaskpilotTaskAction.bind(null, emailAccountId),
    {
      onSuccess: ({ data }) => {
        if (!data) return;
        toastSuccess({
          description: data.alreadyExisted
            ? `Already linked to ${data.taskpilotIdentifier}`
            : `Task ${data.taskpilotIdentifier} created`,
        });
        onOpenChange(false);
      },
      onError: (error) => {
        toastError({
          description: getActionErrorMessage(error.error, {
            prefix: "Failed to create task",
          }),
        });
      },
    },
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: draft.execute is stable; adding it would cause an infinite re-fire loop
  useEffect(() => {
    if (!open) {
      setForm(null);
      setProjects([]);
      setLabelsByProject({});
      setDraftError(null);
      return;
    }
    draft.execute({ messageId });
  }, [open, messageId]);

  const isLoading = draft.isExecuting || (!form && !draftError);
  const allowedLabels = form ? (labelsByProject[form.projectId] ?? []) : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Convert email to TaskPilot task</DialogTitle>
        </DialogHeader>
        <LoadingContent
          loading={isLoading}
          error={draftError ? { error: draftError } : undefined}
        >
          {form && (
            <div className="space-y-3">
              <div>
                <p className="text-xs text-muted-foreground">Project</p>
                <Select
                  value={form.projectId}
                  onValueChange={(v) =>
                    setForm({ ...form, projectId: v, labelNames: [] })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.identifier} — {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Title</p>
                <Input
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  maxLength={200}
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Description</p>
                <Textarea
                  value={form.description_html}
                  onChange={(e) =>
                    setForm({ ...form, description_html: e.target.value })
                  }
                  rows={6}
                />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <p className="text-xs text-muted-foreground">Priority</p>
                  <Select
                    value={form.priority}
                    onValueChange={(v) =>
                      setForm({ ...form, priority: v as Priority })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Priority" />
                    </SelectTrigger>
                    <SelectContent>
                      {(
                        [
                          "urgent",
                          "high",
                          "medium",
                          "low",
                          "none",
                        ] as Priority[]
                      ).map((p) => (
                        <SelectItem key={p} value={p}>
                          {p}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex-1">
                  <p className="text-xs text-muted-foreground">Target date</p>
                  <Input
                    type="date"
                    value={form.targetDate ?? ""}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        targetDate: e.target.value || undefined,
                      })
                    }
                  />
                </div>
              </div>
              {allowedLabels.length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground">Labels</p>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {allowedLabels.map((l) => {
                      const selected = form.labelNames.includes(l.name);
                      return (
                        <button
                          type="button"
                          key={l.id}
                          onClick={() =>
                            setForm({
                              ...form,
                              labelNames: selected
                                ? form.labelNames.filter((n) => n !== l.name)
                                : [...form.labelNames, l.name],
                            })
                          }
                          className={
                            "rounded-full border px-2 py-0.5 text-xs " +
                            (selected
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-border text-muted-foreground")
                          }
                        >
                          {l.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <Button
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={commit.isExecuting}
                >
                  Cancel
                </Button>
                <Button
                  disabled={commit.isExecuting || !form.title.trim()}
                  onClick={() => {
                    commit.execute({ messageId, draft: form });
                  }}
                >
                  {commit.isExecuting ? "Creating…" : "Create task"}
                </Button>
              </div>
            </div>
          )}
        </LoadingContent>
      </DialogContent>
    </Dialog>
  );
}
