# Mail UI rebuild: upstream's look on the fork's existing mail screen

Status: SUPERSEDED 2026-11-16 by docs/designs/refork-upstream.md (owner wants upstream's full mail client and unified inbox, which this look-only port cannot deliver). Was v2, after EGM review (design, codebase accuracy, implementation readiness). Waiting for the
owner's approval; no code before it.
Inputs: roadmap Task 18 (`docs/superpowers/plans/2026-11-05-inbox-post-move-roadmap.md`); research
`.claude/scratchpad/2026-11-16-ui-rebuild-research.md` (upstream `bc6b16d0b`, 2026-11-09; fork `3c9dbd4db`).
All paths are under `apps/web/` unless written otherwise.

## Goal
`/[emailAccountId]/mail` looks like upstream's new mail screen: a Mail / Assistant switch at the top of the
sidebar, a calm labels sidebar, a date-grouped thread list, the reader beside it, and a resizable chat panel that
knows which email is open. Every feature the fork's mail screen has today keeps working (parity table below).

## Constraints (roadmap, owner)
- Fork code only. Upstream is a visual reference; we copy markup and styles, never merge or import its packages.
- Product name "Inbox", fork logo (`utils/branding.ts`, `components/Logo.tsx`). No user-visible "Inbox Zero".
- No billing, upgrade, credit or trial UI.
- No SQLite mail engine (`packages/mail-*`, `utils/mail-engine`, Electron). Data stays on `/api/threads` + SWR.
- Dev on the Mac only; production images build in CI.
- Shared mailboxes keep working: no new access check by `userId`; reads go through the request's email account.
- Redis keys only under `inbox:` (the client adds it).

## Approach: restyle what exists
The fork already has every working part; the rebuild changes their look and adds two things (date groups, chat
context).

| Part | Today | Change |
|---|---|---|
| Sidebar | `components/SideNav.tsx`: `MailNav` on `/mail` (mailboxes via `?type=`, labels via `useSplitLabels`), Logo + `AccountSwitcher` header, "Back" link | Restyle `MailNav` rows like upstream; header row gets the Mail / Assistant switch (new `components/SideNavSectionSwitch.tsx`, used inside `SideNav`'s header on every route) replacing the "Back" link |
| List + reader split | `components/email-list/EmailList.tsx` `ResizablePanelGroup` (list \| `EmailPanel`), open thread = `?thread-id=` | Keep the split and URL param; restyle `EmailListItem` as upstream's row; add date headers |
| Reader + reply | `EmailPanel.tsx` (TaskPilot, `ActionButtons`, `PlanExplanation`, `EmailThread` with inline `ReplyPanel`/`ComposeEmailFormLazy`, Reply-To fix) | Restyle the frame and message cards only; no logic change |
| Chat | `components/SidebarRight.tsx` fixed 450 px, mounted on every route by `SideNavWithTopNav.tsx`; `ContentWrapper` `lg:mr-[450px]` | Make the width resizable on all routes (one CSS variable, default 450 px) and pass the open thread as chat context |
| Keyboard | `CommandK.tsx` owns `e`, `c`, `Esc` | Unchanged: CommandK stays the only page-wide key handler |

No `NewMailShell`, no `MailSidebar`, no `PanelResizeHandle`, no vendored sanitizer: email HTML keeps the single
existing path (`EmailContents.tsx`, DOMPurify + iframe).

## Decisions (defaults; the owner confirms or changes)
1. **Look only, on the existing data path** (above). Not the engine: 4 packages, ~25 models, 112 migrations and a
   collision with the fork's MCP OAuth tables.
2. **Mail / Assistant switch**: Mail -> `/[id]/mail`, Assistant -> `/[id]/automation`. The chat page `/assistant`
   stays reachable from the chat panel and the sidebar.
3. **First pass scope**: look, date groups, resizable chat, chat context. Not now: unread counts, label colours,
   star action, j/k navigation, list virtualisation, split tabs, bundles, snooze, scheduled send, snippets,
   signature manager, Discussions, unified inbox, voice. Each later item gets its own small design.
4. **Composer unchanged**: inline reply as today, new mail via `ComposeModalProvider`.
5. **TaskPilot stays** (`TaskpilotBadge` in rows, `TaskpilotConvertButton` in the reader).
6. **No feature flag**: because the change is a restyle of the same components with no data or behaviour change,
   each slice ships directly; rollback is a revert or the image pin. (A flag would need a second copy of every
   component to switch between.)

## Contracts
- **URL** unchanged: `?type=inbox|draft|sent|archive|CATEGORY_*`, `?type=label&labelId=<id>`, `?thread-id=<id>`,
  and CommandK's `side-panel-thread-id`.
- **List refresh**: `refetchEmailListAtom` (`store/email.ts`) stays set by `mail/page.tsx`; it removes
  `removedThreadIds` from the SWR cache without revalidating (`mail/page.tsx:60-88`). Unchanged.
- **Date groups**: `groupThreadsByDate<T>(items: T[], getDate: (t: T) => Date, now: Date, timeZone: string):
  { label: string; items: T[] }[]` in `components/email-list/group-threads-by-date.ts`, using `@date-fns/tz`.
  `timeZone` = `Intl.DateTimeFormat().resolvedOptions().timeZone`. Buckets in order: "Today", "Yesterday",
  "This week" (Monday start, excluding the two above), "This month", then one bucket per older month labelled
  `MMMM yyyy`. Date per thread = the last message's `internalDate`. Order inside a bucket = input order.
- **Chat context**: `messageContextSchema` (`app/api/chat/validation.ts`) becomes a discriminated union of the
  existing `fix-rule` member and `{ type: "open-thread"; threadId: string }`. The client sets it through
  `ChatProvider`'s existing `setContext` while a thread is open on `/mail` and clears it when the thread closes or
  the route leaves `/mail`. The server (`utils/ai/assistant/chat.ts`, next to the `fix-rule` branch) adds a hidden
  system line: "The user has thread <id> open; use readEmail for it when asked about 'this email'." It does not
  read the thread itself; `readEmailTool` already reads through the request's email account, so a thread from
  another mailbox is simply not found. No `emailAccountId` in the body.
- **Chat width**: CSS variable `--chat-width` set on the app layout, from cookie `inbox-chat-width` (integer px,
  default 450, clamped 320-720, anything unparsable = 450); `SidebarRight` and `ContentWrapper` use it instead of
  the literal 450 px. Resizing writes the cookie (`path=/`, 1 year, `sameSite=lax`).

## Parity table (must work after every slice)
| Feature | Where today |
|---|---|
| Planned tab | `EmailList.tsx:55-84` |
| Bulk select: archive, delete, run rules | `EmailList.tsx:283-387` |
| Per-email run rules / archive, jump to next after archive | `EmailPanel.tsx` `ActionButtons` |
| Rule explanation | `PlanExplanation` |
| TaskPilot badge + convert | `EmailListItem.tsx:178`, `EmailPanel.tsx:52` |
| Inline reply with Reply-To | `EmailMessage.tsx:100-330` |
| Empty inbox message | `EmailList.tsx:135-136` |
| CommandK archive / compose / close | `CommandK.tsx:143-180` |
| `EmailList` reuse in other pages | `stats/NewsletterModal.tsx:20`, `no-reply/page.tsx:7` |
| Shared mailbox (admin@) lists and opens for the share grantee | `utils/email-account-access.ts` via middleware |

## Slices (one PR each; each deploys to production)
| # | Slice | Done when |
|---|---|---|
| 1 | Sidebar header switch + `MailNav` restyle | `SideNavSectionSwitch` unit test: active section from pathname (`/x/mail` -> Mail, `/x/automation` -> Assistant, other routes -> neither highlighted); links point at `/<id>/mail` and `/<id>/automation`. Logged-in check: `/mail`, `/automation`, `/settings`, `/bulk-unsubscribe`, `/clean`, `/assistant` return 200 with 0 `console.error`; the left sidebar shows the same items as before plus the switch; at 390 px the sidebar opens as a sheet from `SidebarTrigger`. |
| 2 | Row restyle + date groups | `group-threads-by-date.test.ts`: fixture `now = 2026-11-15T19:00:00Z`, `Asia/Kolkata`: `2026-11-15T18:45Z` -> Today, `2026-11-15T18:00Z` -> Yesterday; same items in `UTC`: both Today; Monday-start week; older months labelled `October 2026`; empty input -> `[]`. Parity table rows 1, 2, 5, 7, 10 checked in the browser on production. |
| 3 | Reader frame restyle | Parity rows 3, 4, 6 checked in production (one real reply sent to the owner's own address, Reply-To honoured); draft HTML: no `&amp;amp;`, signature div present. |
| 4 | Resizable chat + open-thread context | `validation.test.ts`: `open-thread` parses, unknown `type` rejected, `fix-rule` unchanged; `chat` unit test: hidden line present for `open-thread`, absent without context; cookie parse tests (undefined, "", "abc", "-5", 100 -> 320, 900 -> 720, "300.7" -> 300). Production: with a thread open, "summarise this email" answers about that thread; "fix with chat" still works; chat width persists across reloads; the 6 routes above still pass. |

Every slice: tests first (`// @vitest-environment jsdom` for component tests; vitest defaults to node), tsc 0,
biome 0 errors, every CI check passing, then the per-deploy check (health SHA, logs, logged-in pages).

## Strip guard (ships in slice 1)
`__tests__/ui-strip-guard.test.ts` reads every file changed by this work (`SideNav.tsx`, `SideNavSectionSwitch.tsx`,
`components/email-list/*`, `SidebarRight.tsx`, `SideNavWithTopNav.tsx`, `components/assistant-chat/*`,
`providers/ChatProvider.tsx`) and fails if any contains: `Inbox Zero`, `usePremium`, `PremiumModal`,
`PremiumAlertWithData`, `decrementUnsubscribeCredit`, `AiAutomationStatusBanner`, `EndTrialButton`,
`trial-preview`, `getInboxZeroDesktopApp`. `PremiumCard` already renders in `SideNav.tsx:293` and is hidden in
production by `NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS`; it is left as is.

## Risks
- `SideNav`, `SideNavWithTopNav` and `SidebarRight` render on every route: slices 1 and 4 run the logged-in check
  on all six routes.
- Chat context changes the `/api/chat` request contract: the union keeps `fix-rule` byte-compatible; this doc is
  the contract record (the repo has no `EGM.md`).
- Model choice is untouched (`utils/llms/model.ts` `selectChatModel`, LiteLLM).
