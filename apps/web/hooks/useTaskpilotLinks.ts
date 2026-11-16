import { useMemo } from "react";
import chunk from "lodash/chunk";
import useSWR, { type ScopedMutator } from "swr";
import type { TaskpilotLinksResponse } from "@/app/api/user/me/taskpilot-links/route";
import {
  TASKPILOT_LINKS_MAX_THREADS,
  type TaskpilotLinksBody,
} from "@/app/api/user/me/taskpilot-links/validation";
import { swrFetcher } from "@/providers/swr-fetcher";
import { useAccount } from "@/providers/EmailAccountProvider";

const TASKPILOT_LINKS_KEY = "taskpilot-links";

/** TaskPilot badges for the listed threads, keyed by thread id. */
export function useTaskpilotLinks(
  threads: { id: string; messages: { id: string }[] }[],
) {
  const { emailAccountId } = useAccount();
  const body = useMemo<TaskpilotLinksBody["threads"]>(
    () =>
      threads.map((thread) => ({
        threadId: thread.id,
        messageIds: thread.messages.map((message) => message.id),
      })),
    [threads],
  );
  const key =
    emailAccountId && body.length > 0
      ? ([
          TASKPILOT_LINKS_KEY,
          emailAccountId,
          body.map((t) => `${t.threadId}:${t.messageIds.length}`).join(","),
        ] as const)
      : null;

  return useSWR<TaskpilotLinksResponse>(key, async () => {
    const responses = await Promise.all(
      chunk(body, TASKPILOT_LINKS_MAX_THREADS).map(
        (threadsChunk) =>
          swrFetcher(
            "/api/user/me/taskpilot-links",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ threads: threadsChunk }),
            },
            emailAccountId,
          ) as Promise<TaskpilotLinksResponse>,
      ),
    );
    return Object.assign({}, ...responses);
  });
}

/** Refetch every list's badges, e.g. after a conversion. */
export function revalidateTaskpilotLinks(mutate: ScopedMutator) {
  return mutate((key) => Array.isArray(key) && key[0] === TASKPILOT_LINKS_KEY);
}
