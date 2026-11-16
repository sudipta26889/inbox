"use client";

import { useState } from "react";
import useSWR from "swr";
import {
  CheckCircleIcon,
  XCircleIcon,
  ClockIcon,
  AlertTriangleIcon,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { LoadingContent } from "@/components/LoadingContent";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toastSuccess, toastError } from "@/components/Toast";
import type { GetA2aApprovalsResponse } from "@/app/api/user/a2a-approvals/route";

export default function A2aApprovalsPage() {
  const { data, isLoading, error, mutate } = useSWR<GetA2aApprovalsResponse>(
    "/api/user/a2a-approvals",
  );
  const [selectedApproval, setSelectedApproval] = useState<any>(null);
  const [isApproving, setIsApproving] = useState(false);
  const [isRejectDialogOpen, setIsRejectDialogOpen] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");

  const handleApprove = async (taskId: string) => {
    setIsApproving(true);
    try {
      const res = await fetch("/api/user/a2a-approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId }),
      });

      if (!res.ok) {
        throw new Error("Failed to approve task");
      }

      toastSuccess({ description: "Task approved successfully" });
      mutate();
    } catch (error) {
      toastError({ description: "Failed to approve task" });
    } finally {
      setIsApproving(false);
    }
  };

  const handleReject = async () => {
    if (!selectedApproval || !rejectionReason.trim()) {
      toastError({ description: "Please provide a rejection reason" });
      return;
    }

    setIsApproving(true);
    try {
      const res = await fetch("/api/user/a2a-approvals/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: selectedApproval.taskId,
          rejectionReason,
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to reject task");
      }

      toastSuccess({ description: "Task rejected" });
      setIsRejectDialogOpen(false);
      setSelectedApproval(null);
      setRejectionReason("");
      mutate();
    } catch (error) {
      toastError({ description: "Failed to reject task" });
    } finally {
      setIsApproving(false);
    }
  };

  return (
    <div className="content-container pb-12">
      <div className="mx-auto max-w-5xl space-y-6 pt-4">
        <PageHeader
          title="A2A Task Approvals"
          description="Review and approve tasks requested by external AI agents"
        />

        <LoadingContent loading={isLoading} error={error}>
          {data?.approvals && data.approvals.length > 0 ? (
            <div className="space-y-4">
              {data.approvals.map((approval) => (
                <Card key={approval.id}>
                  <CardHeader>
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <CardTitle className="flex items-center gap-2">
                          <AlertTriangleIcon className="h-5 w-5 text-amber-500" />
                          {approval.skill}
                        </CardTitle>
                        <CardDescription className="mt-1">
                          {approval.requestReason ||
                            "External agent requesting approval"}
                        </CardDescription>
                      </div>
                      <div className="flex flex-col gap-2">
                        <Badge variant="secondary" className="text-xs">
                          <ClockIcon className="mr-1 h-3 w-3" />
                          {new Date(approval.requestedAt).toLocaleString()}
                        </Badge>
                        {approval.clientId && (
                          <Badge variant="outline" className="text-xs">
                            {approval.clientId}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </CardHeader>

                  <CardContent className="space-y-4">
                    {/* Request Data */}
                    <div>
                      <Label className="text-sm font-medium">
                        Request Data:
                      </Label>
                      <pre className="mt-2 rounded-md bg-muted p-3 text-xs overflow-x-auto">
                        {JSON.stringify(approval.requestData, null, 2)}
                      </pre>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex gap-2">
                      <Button
                        onClick={() => handleApprove(approval.taskId)}
                        disabled={isApproving}
                        className="flex-1"
                      >
                        <CheckCircleIcon className="mr-2 h-4 w-4" />
                        Approve
                      </Button>
                      <Button
                        variant="destructive"
                        onClick={() => {
                          setSelectedApproval(approval);
                          setIsRejectDialogOpen(true);
                        }}
                        disabled={isApproving}
                        className="flex-1"
                      >
                        <XCircleIcon className="mr-2 h-4 w-4" />
                        Reject
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="py-12 text-center">
                <CheckCircleIcon className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium mb-2">
                  No Pending Approvals
                </h3>
                <p className="text-sm text-muted-foreground">
                  All A2A tasks are approved or no tasks require approval at the
                  moment.
                </p>
              </CardContent>
            </Card>
          )}
        </LoadingContent>

        {/* Rejection Dialog */}
        <Dialog open={isRejectDialogOpen} onOpenChange={setIsRejectDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Reject Task</DialogTitle>
              <DialogDescription>
                Please provide a reason for rejecting this task. This will be
                recorded in the task history.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {selectedApproval && (
                <div className="rounded-md bg-muted p-3">
                  <p className="text-sm font-medium">
                    {selectedApproval.skill}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {selectedApproval.requestReason}
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="rejectionReason">Rejection Reason *</Label>
                <Textarea
                  id="rejectionReason"
                  placeholder="e.g., This action requires manual review first..."
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  rows={4}
                  required
                />
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setIsRejectDialogOpen(false);
                  setSelectedApproval(null);
                  setRejectionReason("");
                }}
                disabled={isApproving}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleReject}
                disabled={isApproving || !rejectionReason.trim()}
              >
                {isApproving ? "Rejecting..." : "Reject Task"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
