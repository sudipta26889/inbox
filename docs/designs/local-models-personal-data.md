# Local models for personal data

Status: draft v2, 2026-11-19. Policy: every model call that
carries personal data uses `recursivesi/flint` (chat) and
`local/decision` (decisions) through the self-hosted LiteLLM gateway, in dev and production, with no cloud fallback.
Embeddings stay on `embeddinggemma-2`. The prompts and harness are also the prompts and harness to be tuned so Inbox works
well on these two models.

## 1. Scope
Every Inbox model call reads mail, calendar or contacts, so every call is in scope: rule matching, cold email,
sender categories, thread status, recurring patterns, bulk filters, filing, drafts and follow-ups, reply memory,
writing style, autocomplete, translate, digest, meeting briefs and summaries, reports, assistant chat, MCP agent,
TaskPilot routing, the decision layer. Embeddings are already local.

## 2. What the two models are (measured 2026-11-19, made-up text, Inbox key)
**`local/decision`** = `strands-decider:2b` on db-server Ollama, LiteLLM `/systemone`, 15 s timeout, no retries, no
fallback.
- Accepts Inbox's existing System One request unchanged (JSON state part; `choice` with `instructions` and
  `criteria`; `noul`). 0.2 to 0.9 s.
- Reply carries `probabilities` and a separate `confidence` that is lower than the top probability (0.90 vs 0.977
  on one item). Inbox thresholds must read the field the code reads today; the threshold is chosen from shadow data,
  not copied from Jev's 0.95.

**`recursivesi/flint`** = a reasoning model served by LM Studio on a single workstation that is not always on;
one request stream shared by several apps.
- Always reasons first: 80 to 1 200 reasoning tokens per call, about 50 output tokens/s.
- Short classification with a described rule list: 3 to 4 s, correct with tool call, `json_schema`, or plain JSON.
- Without the rule descriptions in the prompt it picked a wrong enum value while its own reason was right: the
  prompt must carry the meaning of every option.
- A 60-word reply draft: about 22 s, about 1 000 reasoning tokens.
- 8 000 input tokens: 12 s, read correctly.
- `reasoning_effort` is accepted and ignored (`low` and `medium` gave identical output and token counts).

## 3. Harness design
### 3.1 Decision first, Flint second
Classification goes to `local/decision` (cheap, fast, no Flint load); Flint generates text and decides only when
the decision model is unsure. This keeps Flint traffic to drafts, summaries, chat and the uncertain minority.
- `DEFAULT_DECISION_MODEL=litellm:local/decision`, `DECISION_ESCALATION_MODEL=litellm:recursivesi/flint`.
- Shadow first: `DECISION_MODEL_LIVE=` (empty). Every feature records `DecisionModelRun` rows next to Flint's answer.
  After about a week of shadow rows, pick a per-feature threshold where the decision model agrees with Flint at
  least 98% of the time, report it, and only then set `DECISION_MODEL_LIVE`.

### 3.2 Flint-specific settings
- Add `flint` to `LITELLM_REASONING_FAMILIES` only for output-budget purposes, not for `reasoningEffort` (ignored).
  Never set a small `maxOutputTokens` on a Flint call: reasoning spends the budget first and the answer comes back
  empty. Rule: at least 2 000 output tokens for any Flint call.
- Prompts give every option its meaning (rule name plus instructions), keep the task statement first, and ask for
  the answer last.
- Shared concurrency: one Flint call at a time per Inbox deployment, a Redis lock keyed `inbox:flint`, so a mail
  burst queues instead of stalling the fleet's single stream.

### 3.3 When Flint is down
- Incoming mail: a model error in rule matching is rethrown (`utils/ai/choose-rule/match-rules.ts:269-271`), so no
  `ExecutedRule` is written. The 30-minute polling job (`app/api/process-emails/process-account.ts:136-190`) already
  reprocesses unread inbox mail that has no `ExecutedRule`. So incoming mail is retried every 30 minutes with no new
  queue.
  Limits (superseded by the read-mail retry below): only unread inbox mail and only the latest 50 are retried; mail read on the phone before
  Flint returns is not processed.
- Check needed: the side paths that swallow errors (`run-rules.ts:631`, `:784-806`, categorize-sender at
  `process-history-item.ts:210`) must not write a SKIPPED row on a model error. The developer verifies each one
  with a test.
- Read mail too: a message that fails with a model-unavailable error is remembered in Redis
  (`inbox:llm-retry:<account>`, first-failure time) and the poll retries it read or unread, for 72 h from the first
  failure, bypassing the 24 h "too old" guard. Outage errors include connection errors, timeouts, 5xx, 408, 429, and
  LM Studio's own 400/404 (`Lm_studioException`, e.g. `'terminated'`, measured 2026-11-19).
- A failed draft during an outage is rethrown, not swallowed, so the email is not marked handled without its draft.
- Known limit: when several rules match and the outage hits after the first rule was written, the later rules are
  not retried (the first rule's ExecutedRule marks the message handled). Nothing runs twice; this is the safer
  failure.
- Interactive paths (assistant chat, on-demand drafts, MCP agent) return "local model offline, try later".
- Digest: waits for its next run.
- No cloud fallback anywhere: role lists hold one entry, and the TaskPilot fallback stays empty.

### 3.4 Data and config
- Prisma data migration : every `User` row with a saved model gets `aiProvider='litellm'`,
  `aiModel='recursivesi/flint'`, `aiApiKey=NULL`. The saved choice beats the Env (`usesSavedModel`,
  `utils/llms/model.ts:98`).
- `env.ts`: TaskPilot model defaults change from `kimi-k2.6` to `recursivesi/flint`.
- Stack 209 Env: the model keys listed in §3.1-3.4. Dev `.env.local`: done 2026-11-19.
- Enforcement: the narrow LiteLLM key (Flint, local/decision, embeddinggemma-2) issued by the gateway operator.

## 4. Prompt tuning, measured
- Baseline: the repo's eval suites with `EVAL_MODELS=[{"provider":"litellm","model":"recursivesi/flint"}]` and
  `DEFAULT_DECISION_MODEL=litellm:local/decision`, one request at a time (Flint is shared). Priority: choose-rule,
  cold-email, categorize-senders, thread-status, draft-reply, digest summary, assistant-chat core tools.
- Fix general failure modes found there (missing option meanings, answer-format drift, over-long prompts), never
  eval wording. Every prompt change is disclosed and re-measured.
- Eval fixtures are synthetic; the judge model sees only those.

## 5. Not switchable without an explicit policy exception
- Meeting-brief web research (Perplexity) and the OpenRouter web-search plugin (`utils/ai/web-search.ts:33`).
- OpenAI text-to-speech (`utils/voice/providers/openai.ts`): Flint has no speech.
- DharaHIL cards carry from/to/subject and draft text to Slack and Telegram.

## 6. Checks (definition of done)
- Unit: a model error during rule matching leaves no `ExecutedRule` (main path and each side path).
- Unit: with the target config, every use case resolves to `litellm:recursivesi/flint` and TaskPilot has no
  fallback.
- Evals: Flint's pass rate per priority suite reported before and after tuning.
- Dev run on the dev mailbox: LiteLLM log for the Inbox key shows only local models.
- Production: `/api/health` shows the merge SHA; 24 h of LiteLLM log for the Inbox key show zero cloud and Jev
  calls; shadow `DecisionModelRun` rows accruing.
