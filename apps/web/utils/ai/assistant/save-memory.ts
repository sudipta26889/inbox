import "server-only";
import type { MemorySource } from "@/generated/prisma/enums";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";

/**
 * Save a durable memory, retiring whatever it replaces.
 *
 * Before this, a contradiction was simply appended: "digest at 5am" and
 * "digest at 7am" both sat in the table and both went into the prompt, and the
 * model picked whichever the retriever happened to rank higher. Benchmarks on
 * exactly this failure (STALE, arXiv:2605.06527) find that visibility does not
 * imply authority — new evidence was retrieved in 77.5% of cases and still
 * failed to govern the answer, because both facts were present and neither was
 * marked as the current one. Labelling both is measurably not enough. The
 * superseded row has to leave the context.
 *
 * Resolution is deterministic, on `subject`. No LLM judge and no embedding
 * threshold: judges are unreliable at this (3.3% of retrieved contradictions
 * were flagged), and embeddings rank negations ABOVE paraphrases, so
 * similarity is a fine way to FIND candidates and a terrible way to decide.
 *
 * ponytail: subject matching only, exact. The model is shown this account's
 * live subjects when it calls saveMemory, so it usually reuses the right key —
 * but nothing enforces it, and two names for one slot still means two live
 * rows. Degradation, not regression. Upgrade path is a nightly sweep that
 * clusters live subjects and merges keys.
 */
export async function saveMemory({
  emailAccountId,
  content,
  subject,
  source = "AGENT_INFERRED",
  chatId,
  validFrom = new Date(),
  logger,
}: {
  emailAccountId: string;
  content: string;
  /** Slot this fact occupies. Without one, nothing is superseded. */
  subject?: string | null;
  source?: MemorySource;
  chatId?: string | null;
  validFrom?: Date;
  logger: Logger;
}): Promise<{
  saved: boolean;
  deduplicated: boolean;
  supersededCount: number;
  bornSuperseded: boolean;
}> {
  const duplicate = await prisma.chatMemory.findFirst({
    where: { emailAccountId, content, supersededAt: null },
    select: { id: true },
  });

  if (duplicate) {
    return {
      saved: false,
      deduplicated: true,
      supersededCount: 0,
      bornSuperseded: false,
    };
  }

  const rivals = subject
    ? await prisma.chatMemory.findMany({
        where: { emailAccountId, subject, supersededAt: null },
        select: { id: true, validFrom: true, source: true },
      })
    : [];

  // Late-arriving old news must not overwrite newer knowledge: a memory
  // describing an older state than the one already stored is born superseded
  // instead of retiring it.
  const stale = rivals.some((rival) => rival.validFrom > validFrom);

  // An inference the assistant made may not quietly undo something the user
  // said outright. It still gets saved — it just doesn't win the slot.
  const wouldOverrideUser =
    source === "AGENT_INFERRED" &&
    rivals.some((rival) => rival.source === "USER_STATED");

  const bornSuperseded = stale || wouldOverrideUser;
  const toRetire = bornSuperseded ? [] : rivals.map((rival) => rival.id);

  if (bornSuperseded) {
    logger.info("Saving memory as already superseded", {
      subject,
      reason: stale ? "older than the stored fact" : "would override the user",
    });
  }

  const now = new Date();

  // Array form, not the callback form — AGENTS.md forbids dynamic transactions.
  // Retiring the old rows and writing the new one must not half-happen: that
  // would leave two live rows in one slot, which is the bug this prevents.
  const [, created] = await prisma.$transaction([
    prisma.chatMemory.updateMany({
      where: { id: { in: toRetire } },
      data: { supersededAt: now },
    }),
    prisma.chatMemory.create({
      data: {
        content,
        subject: subject ?? null,
        source,
        validFrom,
        supersededAt: bornSuperseded ? now : null,
        chatId: chatId ?? null,
        emailAccountId,
      },
      select: { id: true },
    }),
  ]);

  // Provenance, not correctness — recall already filters on supersededAt,
  // committed above. supersededById is unique (one successor points back to one
  // predecessor), so this links only the ordinary single-rival case; a slot that
  // somehow held two live rows still gets both retired, just unlinked.
  if (toRetire.length === 1) {
    try {
      await prisma.chatMemory.update({
        where: { id: toRetire[0] },
        data: { supersededById: created.id },
      });
    } catch (error) {
      logger.warn("Could not link a superseded memory to its replacement", {
        error,
      });
    }
  } else if (toRetire.length > 1) {
    logger.warn("Retired several live memories from one slot", {
      subject,
      count: toRetire.length,
    });
  }

  return {
    saved: true,
    deduplicated: false,
    supersededCount: toRetire.length,
    bornSuperseded,
  };
}
