import prisma from "@/utils/prisma";
import { computeCost } from "@/utils/taskpilot/pricing";
import { DecisionsTable } from "./decisions-table";

export default async function TaskpilotDecisionsPage() {
  const rows = await prisma.taskpilotDecision.findMany({
    orderBy: { ranAt: "desc" },
    take: 200,
  });
  const enriched = rows.map((r) => ({
    ...r,
    pass1Cost: r.pass1Model
      ? computeCost({
          model: r.pass1Model,
          inputTokens: r.pass1InputTokens ?? 0,
          outputTokens: r.pass1OutputTokens ?? 0,
        })
      : 0,
    pass2Cost: r.pass2Model
      ? computeCost({
          model: r.pass2Model,
          inputTokens: r.pass2InputTokens ?? 0,
          outputTokens: r.pass2OutputTokens ?? 0,
        })
      : 0,
  }));
  return (
    <div className="container mx-auto py-8">
      <h1 className="text-2xl font-bold mb-4">TaskPilot Decisions</h1>
      <DecisionsTable rows={enriched} />
    </div>
  );
}
