import type { Pass1Decision, StateGroup } from "@/utils/taskpilot/schemas";

export interface ValidationContext {
  canCreate: boolean;
  candidateIssueIds: Set<string>;
  projectIds: Set<string>;
  projectLabels: Map<string, Set<string>>;
}

export type ValidationResult =
  | { kind: "ok"; decision: Pass1Decision; warnings: string[] }
  | { kind: "downgrade"; reason: string };

const TERMINAL_GROUPS: ReadonlySet<StateGroup> = new Set([
  "completed",
  "cancelled",
]);

export function validatePass1Decision(
  decision: Pass1Decision,
  ctx: ValidationContext,
): ValidationResult {
  const warnings: string[] = [];

  if (decision.action === "IGNORE") {
    return { kind: "ok", decision, warnings };
  }

  if (decision.action === "CREATE") {
    if (!ctx.canCreate) {
      return {
        kind: "downgrade",
        reason: "CREATE returned but canCreate is false",
      };
    }
    if (!ctx.projectIds.has(decision.draft.projectId)) {
      return {
        kind: "downgrade",
        reason: `unknown projectId: ${decision.draft.projectId}`,
      };
    }
    const allowedLabels =
      ctx.projectLabels.get(decision.draft.projectId) ?? new Set();
    const cleanedLabels = decision.draft.labelNames.filter((n) =>
      allowedLabels.has(n),
    );
    if (cleanedLabels.length !== decision.draft.labelNames.length) {
      warnings.push(
        `dropped unknown labels: ${decision.draft.labelNames
          .filter((n) => !allowedLabels.has(n))
          .join(", ")}`,
      );
    }
    return {
      kind: "ok",
      decision: {
        ...decision,
        draft: { ...decision.draft, labelNames: cleanedLabels },
      },
      warnings,
    };
  }

  // COMMENT_ON
  const validTargets = decision.targetIssueIds.filter((id) =>
    ctx.candidateIssueIds.has(id),
  );
  if (validTargets.length === 0) {
    return {
      kind: "downgrade",
      reason: "all targetIssueIds are hallucinated (not in candidates)",
    };
  }
  if (validTargets.length !== decision.targetIssueIds.length) {
    warnings.push(
      `dropped hallucinated targets: ${decision.targetIssueIds
        .filter((id) => !ctx.candidateIssueIds.has(id))
        .join(", ")}`,
    );
  }

  let stateGroup = decision.stateGroup;
  if (
    stateGroup &&
    TERMINAL_GROUPS.has(stateGroup) &&
    decision.stateConfidence !== "HIGH"
  ) {
    warnings.push(
      `dropped terminal state ${stateGroup} due to ${decision.stateConfidence} confidence`,
    );
    stateGroup = null;
  }

  return {
    kind: "ok",
    decision: {
      ...decision,
      targetIssueIds: validTargets as [string, ...string[]],
      stateGroup,
    },
    warnings,
  };
}
