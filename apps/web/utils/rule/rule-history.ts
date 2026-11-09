import prisma from "@/utils/prisma";
import type { RuleWithRelations } from "@/utils/rule/types";
import { isDuplicateError } from "@/utils/prisma-helpers";

const MAX_VERSION_ATTEMPTS = 3;

export type RuleHistoryTrigger = "created" | "updated";

/**
 * Creates a complete snapshot of a rule in the RuleHistory table
 */
export async function createRuleHistory({
  rule,
  triggerType,
}: {
  rule: RuleWithRelations;
  triggerType: RuleHistoryTrigger;
}) {
  // Serialize actions to JSON
  const actionsSnapshot = rule.actions.map((action) => ({
    id: action.id,
    type: action.type,
    label: action.label,
    subject: action.subject,
    content: action.content,
    to: action.to,
    cc: action.cc,
    bcc: action.bcc,
    url: action.url,
  }));

  // Overlapping writes for one rule can read the same latest version, so retry
  // when the (ruleId, version) unique constraint rejects the insert.
  for (let attempt = 1; ; attempt++) {
    const lastHistory = await prisma.ruleHistory.findFirst({
      where: { ruleId: rule.id },
      orderBy: { version: "desc" },
      select: { version: true },
    });

    try {
      return await prisma.ruleHistory.create({
        data: {
          ruleId: rule.id,
          name: rule.name,
          instructions: rule.instructions,
          enabled: rule.enabled,
          automate: rule.automate,
          runOnThreads: rule.runOnThreads,
          conditionalOperator: rule.conditionalOperator,
          from: rule.from,
          to: rule.to,
          subject: rule.subject,
          body: rule.body,
          systemType: rule.systemType,
          promptText: rule.promptText,
          actions: actionsSnapshot,
          triggerType,
          version: (lastHistory?.version ?? 0) + 1,
        },
      });
    } catch (error) {
      if (
        attempt >= MAX_VERSION_ATTEMPTS ||
        !isDuplicateError(error, ["ruleId", "version"])
      ) {
        throw error;
      }
    }
  }
}
