import { describe, expect, it } from "vitest";
import { buildReindexPayload } from "@/utils/taskpilot/reindex";
import type { TaskComment, TaskDetail } from "@/utils/taskpilot/types";

describe("buildReindexPayload", () => {
  const detail: TaskDetail = {
    id: "iss-1",
    identifier: "X-1",
    name: "Resolve invoice mismatch",
    description_html: "<p>Distributor sent <strong>wrong</strong> figure.</p>",
    state: { id: "s1", name: "In Progress", group: "started" },
    priority: "high",
    assignees: [],
    labels: [
      { id: "l1", name: "billing" },
      { id: "l2", name: "vendor:BPCL" },
    ],
  };

  it("excludes raw email addresses from the embedded text", () => {
    const comments: TaskComment[] = [
      {
        id: "c1",
        author_display_name: "sudipta",
        comment_html: "<p>note</p>",
        created_at: "2026-06-01T00:00:00Z",
      },
    ];
    const payload = buildReindexPayload(detail, comments);
    expect(payload).not.toMatch(/@[\w.]+\.\w+/);
  });

  it("strips HTML to plaintext", () => {
    const payload = buildReindexPayload(detail, []);
    expect(payload).not.toContain("<p>");
    expect(payload).not.toContain("</p>");
    expect(payload).toContain("Distributor sent wrong figure.");
  });

  it("caps comments at 10, oldest first", () => {
    const comments: TaskComment[] = Array.from({ length: 15 }, (_, i) => ({
      id: `c${i}`,
      author_display_name: "x",
      comment_html: `<p>comment-${i}</p>`,
      created_at: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    }));
    const payload = buildReindexPayload(detail, comments);
    expect(payload).toContain("comment-5"); // newest 10 = indices 5..14
    expect(payload).not.toContain("comment-0");
    expect(payload).not.toContain("comment-4");
    // Within payload, comment-5 appears before comment-14 (oldest-first within the kept window).
    expect(payload.indexOf("comment-5")).toBeLessThan(
      payload.indexOf("comment-14"),
    );
  });

  it("includes labels and state", () => {
    const payload = buildReindexPayload(detail, []);
    expect(payload).toContain("billing");
    expect(payload).toContain("vendor:BPCL");
    expect(payload).toContain("In Progress");
    expect(payload).toContain("started");
  });
});
