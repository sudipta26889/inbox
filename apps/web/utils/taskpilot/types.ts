export type Priority = "urgent" | "high" | "medium" | "low" | "none";

export interface Project {
  description?: string | null;
  id: string;
  identifier: string;
  name: string;
}

export interface Label {
  id: string;
  name: string;
}

export interface WorkItemCreateInput {
  description_html: string;
  external_id: string; // gmail message id
  external_source: string; // "inbox"
  labels?: string[]; // label UUIDs
  name: string;
  priority: Priority;
  target_date?: string; // ISO YYYY-MM-DD
}

export interface WorkItemCreateResult {
  alreadyExisted: boolean;
  id: string;
  identifier: string;
  sequence_id: number;
}

export interface IssueLinkInput {
  metadata?: Record<string, unknown>;
  title: string;
  url: string;
}

export type StateGroup =
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "cancelled"
  | "triage";

export interface TaskState {
  group: StateGroup;
  id: string;
  name: string;
}

export interface TaskComment {
  author_display_name: string;
  comment_html: string;
  created_at: string; // ISO
  id: string;
}

export interface TaskDetail {
  assignees: Array<{ id: string; display_name: string; email?: string }>;
  description_html: string;
  id: string;
  identifier: string;
  labels: Array<{ id: string; name: string }>;
  name: string;
  priority: Priority;
  state: { id: string; name: string; group: StateGroup };
  target_date?: string | null;
}

export interface TaskUpdatePatch {
  assignee_ids?: string[]; // full replacement set
  label_ids?: string[]; // full replacement set
  priority?: Priority;
  state?: string; // stateId — same as moveTask, exposed for completeness
  target_date?: string | null;
}
