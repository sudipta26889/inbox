# Flint as a batch model

Status: draft v2, 2026-11-23 (revised after a Goldfish review). Follows `docs/designs/local-models-personal-data.md`.

## Why
`recursivesi/flint` gives about 40 output tokens/s in total across all apps; calls take from seconds to 16 minutes
under load. Policy: nothing a person waits on depends on Flint; Flint work is submitted and collected.

## Interactive vs batch
**Default is batch.** Only use cases flagged interactive in `apps/web/utils/llms/use-cases.ts` leave Flint. Callers
that use `getModel` directly (rule choice, cold email, thread status, rule args, morning report, settings test) are
the incoming-mail pipeline and stay batch.

**Interactive** (a person starts it and waits): `assistant-chat`, `chat-compaction`, `chat-memory-extraction`,
`compose-autocomplete`, `translate-email`, `summarise`, `prompt-to-rules`, `prompt-to-split`,
`unsubscribe-page-state`, `persona-analysis` and `writing-style-analysis` (run during onboarding), the seven
`email-report-*` (report page), `categorize-senders-bulk` (user-started bulk categorise).
**Batch**: everything else, including `mcp-agent` (draft research), `draft-reply` and its sub-calls
(`calendar-availability`, `draft-attachment-selection`, `reply-context-collector`, `reply-memory-selection`), and
`bulk-inbox-action-filter` (has a recovery cron).

## Model choice
- `getModelForUseCase` returns, for an interactive use case, the local stand-in `litellm:gpt-oss-20b` (env
  `INTERACTIVE_LLMS`, default `litellm:gpt-oss-20b`), bypassing the saved account model and `usesSavedModel`. It marks
  the returned model `interactive: true`.
- The cost/nano guard in `utils/llms/index.ts` must not move an interactive call back onto Flint.
- Batch keeps the saved model (Flint).

## Batch harness (one place: the per-candidate `generate` closures in `utils/llms/index.ts`)
1. **One Flint stream per app, queued.** Every non-interactive Flint call goes through an in-process FIFO queue of
   concurrency 1 (`utils/llms/flint-stream.ts`, `p-queue`; all production model calls run in the single web process,
   the cron container only calls its HTTP routes). Parallel calls, such as the five a draft makes at once, wait their
   turn and run one after another. A call that has waited more than 30 minutes without starting (long enough for a draft's five calls in a row) leaves the queue and
   throws `FlintBusyError`, which `isLlmUnavailableError` classifies as unavailable, so the existing path makes it
   "later" (no `ExecutedRule`, `llm-retry` entry, 30-minute poll). The wait ends when the call starts; the run itself
   has no cap. The queue sits inside `generate`, under the retry wrappers, so backoff does not hold the slot. A
   refusing try-lock was rejected: it would fail four of the five parallel draft calls every time.
2. **Output cap** on Flint calls: `maxOutputTokens` 8,192 when the caller sets none (reasoning counts against it; a
   smaller cap makes the call return empty and loop in the retry queue).
3. **Counters** (info log, no content) per Flint call: `useCase` or label, `completionTokens`, `waitedSeconds`,
   `seconds`; and a log when a call is dropped after waiting too long.
Streaming calls are interactive-only today and do not use the queue.

## Not in this change
A night window: Inbox has no bulk job that runs unattended today (all are user-started and now interactive). Add one
when such a job exists.

## Checks
- Unit: each interactive use case resolves to `gpt-oss-20b` for an account saved on Flint (with and without a saved
  key); a direct `getModel` caller and each batch use case stay on Flint.
- Unit: concurrent non-interactive Flint calls (two, and five as in a draft) all complete, one at a time and in
  order; a call that waits past the cap never runs and raises a model-unavailable error, and the queue keeps working;
  a throwing call frees the slot; interactive and non-Flint calls do not wait.
- Unit: a Flint call without `maxOutputTokens` gets 8,192.
- Production: chat answers within seconds on gpt-oss-20b; LiteLLM shows at most one concurrent Flint stream from
  inbox-local; incoming mail keeps being processed (some later, via the poll).
