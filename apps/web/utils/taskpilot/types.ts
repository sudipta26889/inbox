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
