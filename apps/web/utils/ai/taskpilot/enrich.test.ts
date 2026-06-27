import { describe, expect, it, vi } from "vitest";
import {
  enrichEmailIntoTask,
  INBOX_LINK_PLACEHOLDER,
} from "@/utils/ai/taskpilot/enrich";

const baseEmail = {
  subject: "Re: Fwd: Invoice #88",
  from: "vendor@example.com",
  snippet: "Please review",
  bodyText: "Please review the attached invoice. Payment due 2026-07-10.",
  receivedAt: new Date("2026-06-26T10:00:00Z"),
};

const projects = [
  {
    id: "p1",
    identifier: "FIN",
    name: "Finance",
    description: "Invoices and AP",
  },
  { id: "p2", identifier: "WEB", name: "Web", description: "Site work" },
];

const labelsByProject = new Map([
  [
    "p1",
    [
      { id: "l-paid", name: "paid" },
      { id: "l-overdue", name: "overdue" },
    ],
  ],
  ["p2", [{ id: "l-bug", name: "bug" }]],
]);

describe("enrichEmailIntoTask", () => {
  it("returns LLM output when valid", async () => {
    const mockChat = vi.fn().mockResolvedValue({
      object: {
        projectId: "p1",
        title: "Review invoice #88",
        description_html: `<p>From: vendor@example.com</p><a href="${INBOX_LINK_PLACEHOLDER}">Open in Inbox</a>`,
        priority: "high",
        labelNames: ["overdue"],
        targetDate: "2026-07-10",
      },
    });
    const result = await enrichEmailIntoTask({
      email: baseEmail,
      projects,
      labelsByProject,
      chatCompletionObject: mockChat,
    });
    expect(result.projectId).toBe("p1");
    expect(result.title).toBe("Review invoice #88");
    expect(result.labelNames).toEqual(["overdue"]);
    expect(result.targetDate).toBe("2026-07-10");
  });

  it("falls back to deterministic output on Zod failure", async () => {
    const mockChat = vi.fn().mockResolvedValue({
      object: { projectId: "not-a-real-uuid", title: 123, priority: "bogus" },
    });
    const result = await enrichEmailIntoTask({
      email: baseEmail,
      projects,
      labelsByProject,
      chatCompletionObject: mockChat,
    });
    expect(result.projectId).toBe("p1");
    expect(result.title).toBe("Invoice #88"); // Re:/Fwd: stripped
    expect(result.priority).toBe("medium");
    expect(result.labelNames).toEqual([]);
    expect(result.targetDate).toBeUndefined();
  });

  it("filters out labels not in the chosen project's label set", async () => {
    const mockChat = vi.fn().mockResolvedValue({
      object: {
        projectId: "p1",
        title: "Review invoice",
        description_html: "<p>x</p>",
        priority: "medium",
        labelNames: ["overdue", "bug", "fictional"],
      },
    });
    const result = await enrichEmailIntoTask({
      email: baseEmail,
      projects,
      labelsByProject,
      chatCompletionObject: mockChat,
    });
    expect(result.labelNames).toEqual(["overdue"]);
  });

  it("falls back when the LLM throws", async () => {
    const mockChat = vi.fn().mockRejectedValue(new Error("boom"));
    const result = await enrichEmailIntoTask({
      email: baseEmail,
      projects,
      labelsByProject,
      chatCompletionObject: mockChat,
    });
    expect(result.projectId).toBe("p1");
    expect(result.priority).toBe("medium");
  });
});
