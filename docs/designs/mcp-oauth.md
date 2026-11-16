# MCP OAuth: bring Inbox up to the fleet standard

Status: v2, 2026-11-16, after EGM review by three Goldfish reviewers (design, codebase accuracy, implementation
readiness).
Inputs: `~/fleet-tasks/studio-mcp-oauth-standard.md` (the checklist) and `~/fleet-tasks/inbox-to-guardian-mcp-oauth.md` (audit).

## Goal
`https://inbox.sudiptadhara.in/mcp-server` connects from claude.ai, Claude Code, ChatGPT, Cursor, Codex and opencode via
OAuth 2.1 (MCP auth spec 2025-11-25, with 2025-06-18 and older clients still working). Inbox already runs its own
authorization server. This change fixes it; it does not build a new one.

## Owner decisions (2026-11-16)
1. **Every tool stays**, including `send_email`, `delete_draft`, `delete_calendar_event`, `admin_*_delete`,
   `admin_unsubscribe_request` and `admin_cleanup_create_job`, and every scope. This is a deliberate exception to the
   fleet rule that human-gated actions are never MCP tools. The tools must carry `destructiveHint: true`.
2. **The browser-session fallback on `POST /mcp-server` is removed.** There is no in-app caller, and MCP clients send
   Bearer tokens.
3. **CIMD is added** (manager's call; the owner asked what it is). DCR stays for Cursor and older clients.

## Non-goals
- **No new token format.** Tokens stay HS256 JWTs signed with `AUTH_SECRET`, with the `jti` in `McpServerAccessToken`.
- **No change to `/a2a` auth** (`utils/a2a/auth.ts`). Known gap: it accepts MCP-audience tokens without checking
  client type. This is recorded here and left for later.
- **No SSE or GET stream.** `POST` with JSON responses is valid Streamable HTTP. `GET` returns 405.
- **Don't edit `utils/mcp/oauth.ts`.** It is the *outbound* MCP client, and its `plain` is unrelated.

## Constants (`utils/mcp-server/constants.ts`)
- `BASE = new URL(NEXT_PUBLIC_BASE_URL).origin`, so a trailing slash can't creep in.
- `MCP_RESOURCE = BASE + "/mcp-server"` and `PRM_URL = BASE + "/.well-known/oauth-protected-resource/mcp-server"`.
- `SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]`, newest first.
- `TOKEN_CONFIG.AUTHORIZATION_CODE_TTL = 5 * 60`. Every code path uses this constant; the hard-coded 10 min goes.
- `LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"]`, in `URL.hostname` form.
- `REFRESH_REPLAY_GRACE_SECONDS = 30`.
- `MAX_TOOL_TEXT_CHARS = 80_000`, which is about 20k tokens, under Claude Code's 25k limit.

## Migration (the only one, in T3)
Two new fields:
- `McpServerAccessToken.grantId String?`, indexed.
  - Set to a new cuid at authorization-code exchange.
  - Copied to the new row on refresh.
  - `null` for minted static A2A tokens.
- `McpServerAccessToken.revokedReason String?`, with the values `rotated`, `user`, `reuse` and `admin`.

## A. Discovery (T1)
- `middleware.ts` serves the same protected-resource (PRM) JSON at `/.well-known/oauth-protected-resource` and
  `/.well-known/oauth-protected-resource/mcp-server`. Its matcher already covers both paths.
  - `resource: MCP_RESOURCE`.
  - Drop `mcp_protocol_version`.
- AS metadata changes:
  - `code_challenge_methods_supported: ["S256"]`;
  - `token_endpoint_auth_methods_supported: ["none"]`;
  - add `client_id_metadata_document_supported: true` and `authorization_response_iss_parameter_supported: true`;
  - keep `resource_indicators_supported: true`.
- Delete the dead code:
  - `app/api/well-known-oauth/` and `app/api/.well-known/`;
  - the two rewrites in `next.config.ts:112-119`;
  - the unused `withMcpAuth` in `utils/mcp-server/middleware.ts`, if nothing imports it (grep first).

## B. Resource server (`app/mcp-server/route.ts`)
Checks run in this order:
1. **Origin (T1).**
   - No `Origin` header: continue, since that is the server-to-server case.
   - `Origin` is `BASE`, or an `http:`/`https:` URL whose hostname is in `LOOPBACK_HOSTS` (any port): continue.
   - Anything else returns 403, including the literal `null` and an Origin that can't be parsed.
2. **`MCP-Protocol-Version` (T1).** If the header is present and not in `SUPPORTED_PROTOCOL_VERSIONS`, return 400. An
   absent header is fine. Add `MCP-Protocol-Version` and `Mcp-Session-Id` to `CORS_HEADERS` Allow-Headers.
3. **Bearer (T1).**
   - No token: 401 with `WWW-Authenticate: Bearer resource_metadata="<PRM_URL>", scope="<MCP_SCOPES_SUPPORTED joined by space>"`.
     The full list is deliberate: it matches what clients request today (owner decision 1).
   - A bad, expired or revoked token gets the same header plus `error="invalid_token"`.
   - The session fallback and its `auth` mock in `route.test.ts` are deleted.
4. **Audience (T2).**
   - Check it in `route.ts`, not in `validateAccessToken`, which `/a2a` shares.
   - Accept `aud === MCP_RESOURCE`.
   - A token without `aud` is accepted only when its `McpServerClient.type` is `A2A`. This covers static tokens minted
     before this change; the doc doesn't know whether Mitra calls `/mcp-server`.
   - Anything else returns 401 `invalid_token`, and the client then refreshes into an `aud` token.
5. **Scope (T2).** A `tools/call` whose tool needs a scope the token lacks gets HTTP 403 with
   `WWW-Authenticate: Bearer error="insufficient_scope", scope="<the tool's required scope>", resource_metadata="<PRM_URL>"`.
   Lost access to the email account (the second `-32003`, at about `route.ts:295`) becomes a tool result with
   `isError: true` instead.
6. **`initialize` (T2).**
   - Return `params.protocolVersion` if it is in the supported list, otherwise `SUPPORTED_PROTOCOL_VERSIONS[0]`.
   - `instructions` moves to the top level of the result.
7. **Tool results (T2).**
   - A handler throw, or input that fails validation, becomes `{ content:[{type:"text",text}], isError:true }`.
     Unknown method, unknown tool and malformed JSON-RPC stay JSON-RPC errors.
   - An object result also carries `structuredContent`, with the JSON text block kept.
   - A text block over `MAX_TOOL_TEXT_CHARS` is cut and gets `\n[truncated: N chars omitted]`, and `structuredContent`
     is left out.
8. **`GET /mcp-server` (T1).** Returns 405 with `Allow: POST, OPTIONS`.

## C. Tools (T5)
- Every tool in `utils/mcp-server/registry.ts` gets a `title` and all four hints. `readOnlyHint` must be a boolean, and
  `registry.test.ts:56,108` changes accordingly.
- **Read tools:** `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`.
- **Write tools:** `readOnlyHint: false`.
- **`destructiveHint: true`** is set exactly on `send_email`, `delete_draft`, `delete_calendar_event`, every
  `admin_*_delete`, `admin_unsubscribe_request` and `admin_cleanup_create_job`. Every other tool gets `false`.
- **`openWorldHint: true`** only for tools whose effect reaches another person or an outside service: `send_email`,
  calendar create, update, delete and respond, and `admin_unsubscribe_request`. Every other tool gets `false`,
  including drafts, as `registry.test.ts:76` expects.
- The registry test reads the tool list from the registry, never a hard-coded count. It asserts:
  - every tool has a non-empty `title` and four boolean hints;
  - the exact destructive list above;
  - every tool name is at most 64 characters.

## D. Authorize, consent and token (T3)
- **One code helper.** Codes are created in two places today: the skip-consent path in `authorize/route.ts` and
  `consent/approve/route.ts`. Both call a single `issueAuthorizationCode()` in `utils/mcp-server/`. It:
  - generates the code;
  - stores only `sha256(code)`;
  - sets `expiresAt` from `AUTHORIZATION_CODE_TTL`;
  - returns the redirect URL with `code`, `state` (when given) and `iss=BASE`.
- **PKCE.** S256 only; `plain` gets `invalid_request`. A missing method is treated as S256. Update `pkce.test.ts:159`.
- **Redirect URIs.** `validateRedirectUri` is extended, not duplicated, and is reused by DCR and CIMD.
  1. *Format:* `https:`; or `http:` on a loopback host; or one of the custom schemes `claude:`, `cursor:`, `vscode:`,
     `vscode-insiders:` and `windsurf:`.
  2. *Match:* at `/authorize` and `/consent/approve`, the requested URI must equal one of `client.redirectUris`.
     - Scheme, path and query must match exactly.
     - Loopback exception: if both URIs are `http:` with a loopback host, the host may be any of `LOOPBACK_HOSTS` and the
       port may differ, including when the registered URI has no port.
  3. *Token:* at `/token`, a `redirect_uri`, if sent, must equal the code's stored `redirectUri` under the same rule,
     else `invalid_grant`. The log-only branch is removed.
- **Deny.** Deny goes through the server: `POST /mcp-server/consent/approve` with `{deny:true}`. The server validates
  the client and redirect URI, then returns `<redirect>?error=access_denied&state=…&iss=…`. The client-side redirect in
  `consent-content.tsx` is removed.
- **Consent page.**
  - `page.tsx` loads the client from the database on the server, so `client_name`, logo and redirect URIs never come
    from URL parameters. The page shows the redirect URI's host.
  - For a CIMD client, it shows the host of the `client_id` URL as the client's identity.
  - Before the client and redirect URI are validated, the page shows the error page, as today.
- **CSRF.**
  - `POST /consent/approve` requires `Origin === BASE`, else 403.
  - Remove `Access-Control-Allow-Origin: *` from its OPTIONS.
  - The granted scope must pass `validateScopes`. The client's registered `scope`, when set, caps it.
- **`resource` (RFC 8707).**
  - `/authorize` and `/token` accept an optional `resource`.
  - With one trailing slash removed, it must equal `MCP_RESOURCE`, else `invalid_target`. It is not stored.
  - Every token gets `aud: MCP_RESOURCE`. That is issued in T1, see "Order" below.
- **Code exchange.**
  - The code is claimed atomically:
    `updateMany({ where:{ code: sha256(code), clientId, used:false, expiresAt:{gt:now} }, data:{ used:true, usedAt:now } })`.
  - A claim count of 0 when the code row exists with `used:true` is a reuse. Every token whose `grantId` came from that
    code is revoked with reason `reuse`; to link them, store `grantId` on the code row (included in the migration).
- **Refresh.**
  - A missing `client_id` returns `invalid_request`. A `client_id` different from the token's returns `invalid_grant`,
    and nothing is revoked.
  - A row in active use is rotated: it is marked `revoked:true, revokedReason:"rotated"`, and a new row is created with
    the same `grantId`.
  - Replay: the row is already revoked with reason `rotated`, and `revokedAt` is more than
    `REFRESH_REPLAY_GRACE_SECONDS` ago. Then every row with that `grantId` is revoked with reason `reuse`. Within the
    grace window the request still gets `invalid_grant`, as before this change, but the grant is not revoked. That
    keeps a retried or concurrent refresh from killing the session.
  - Reason `user`, `admin` or `reuse`: `invalid_grant`, nothing more.
  - Rows with `grantId: null` are never revoked by a replay.
  - On refresh, recheck the user's access to the email account with the same check as `buildMcpToolContext`; if access
    is lost, return `invalid_grant`.
- **`/revoke`** sets `revokedReason:"user"`.
- **Calendar scope:** keep the existing `calendar:read` to `calendar:write` auto-add.

## E. Client registration (T4)
- **DCR (`/register`).**
  - `token_endpoint_auth_method` is forced to `none`.
  - Redirect URIs go through `validateRedirectUri` step 1.
  - The per-IP rate limit stays.
- **CIMD** (`utils/mcp-server/client-metadata.ts`) is used when `client_id` is an `https:` URL.
  - The fetch happens only after `/authorize` has confirmed a signed-in session. Before that, the user is sent to
    sign-in as today, and nothing is fetched or stored.
  - The same per-IP rate limit as `/register` applies.
  - The fetch:
    - https only, port 443, `redirect: "error"`;
    - a 5 s timeout and a 64 KB body cap (abort past it);
    - `Accept: application/json`.
  - **SSRF guard.** The hostname is resolved once, and every address is refused if it is private, loopback,
    link-local, CGNAT (`100.64/10`), unspecified, multicast or an IPv6 ULA (`fc00::/7`) or link-local address, or
    IPv4-mapped. The connection is pinned to the checked address with an undici `Agent` whose `connect.lookup` returns
    it, which defeats DNS rebinding. undici is already in the lockfile; check with `pnpm why undici` and do not add
    a new dependency.
  - **Document checks:** valid JSON; `client_id === url`; `redirect_uris` is a non-empty array, each entry passing
    step 1; the requested `redirect_uri` matches one of them (step 2 rule); and
    `token_endpoint_auth_method` is absent or `none`.
  - On success, upsert a `McpServerClient` row with `clientId: url`, `type: MCP`, the client's name and the redirect
    URIs. It is re-fetched when `updatedAt` is older than 24 h.

## F. Settings: connections and revoke (T6)
- Change the existing `app/(app)/[emailAccountId]/settings/McpClientsSection.tsx` and `hooks/useMcpClients.ts`. Don't
  add a new section.
- `GET /api/user/mcp-clients` lists only `type: MCP` clients that hold at least one live token for this user. It
  returns `clientName`, the client host and `lastUsedAt`.
- **`DELETE` no longer deletes the client row.** That cascades, and with shared CIMD rows it would wipe every user's
  grant. Instead it runs `updateMany` on that user's tokens for that client: `revoked:true, revokedReason:"user"`. This
  follows `app/api/user/a2a-clients/[clientId]/tokens/route.ts:124-145`.

## Order and tasks
`aud` is issued before it is enforced. T1 makes `generateAccessToken` stamp `aud: MCP_RESOURCE` on every token,
including refreshed ones and those from `scripts/mint-a2a-token.ts`. T2 enforces it.

| # | Scope | Done when (each must pass) |
|---|---|---|
| T1 | A; B1–B3; B8; `aud` issued in `generateAccessToken` | Unit tests cover each branch. With `next dev` on :5500 the checks below pass. |
| T2 | B4–B7 | Route tests cover: `aud` ok; missing `aud` with an A2A client ok; missing `aud` with an MCP client 401; wrong `aud` 401; missing scope 403 with header; `initialize` echoes 2025-06-18 and maps 1999-01-01 to 2025-11-25; `instructions` at the top level; a throw gives `isError`; `structuredContent` present; truncation. |
| T3 | Migration; D | Tests: `plain` rejected; exact and loopback redirect match; `/token` redirect mismatch gives `invalid_grant`; bad `resource` gives `invalid_target`; `iss` in the redirect; code stored hashed; code reuse revokes by `grantId`; refresh replay outside the grace window revokes the grant and inside it does not; `user` and `grantId:null` rows untouched; refresh `client_id` mismatch; deny goes through the server; approve with a foreign Origin gives 403. |
| T4 | E | `client-metadata.test.ts`: non-https, a redirect, an oversize body, a timeout, every refused IP range (v4 and v6), DNS returning a private IP, `client_id` mismatch, a redirect not listed, a non-`none` auth method; a good document upserts; no fetch without a session. |
| T5 | C | The registry test as specified in C. |
| T6 | F | API test: DELETE revokes only that user's tokens and leaves the client row. In dev, in the browser: the connection is listed and Revoke works, then the next `/mcp-server` call with that token gets 401. |

T1 local checks (dev on :5500; production after release uses `https://inbox.sudiptadhara.in`):
```sh
U=http://localhost:5500/mcp-server
curl -s -o /dev/null -w '%{http_code}\n' -X POST $U -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'   # 401
curl -s -D- -o /dev/null -X POST $U -H 'content-type: application/json' -d '{}' | grep -i www-authenticate   # resource_metadata=".../oauth-protected-resource/mcp-server", scope="…"
curl -s http://localhost:5500/.well-known/oauth-protected-resource/mcp-server   # resource == <BASE>/mcp-server
curl -s http://localhost:5500/.well-known/oauth-authorization-server            # ["S256"], ["none"], client_id_metadata_document_supported:true
curl -s -o /dev/null -w '%{http_code}\n' -X POST $U -H 'MCP-Protocol-Version: 1999-01-01' -d '{}'   # 400
curl -s -o /dev/null -w '%{http_code}\n' -X POST $U -H 'Origin: https://evil.example' -d '{}'       # 403
curl -s -o /dev/null -w '%{http_code}\n' $U                                                         # 405
```

Gate for every task:
- `pnpm --filter inbox-ai check-enums && pnpm --filter inbox-ai test` passes;
- `pnpm lint` adds no new errors in touched files;
- `pnpm --filter inbox-ai exec next build` passes at the end (T6).

Tests that will need updating include `route.test.ts:14,33,81`, `registry.test.ts:56,76,108` and
`pkce.test.ts:159`. Update `EGM.md` wherever a contract moves.

Release is done when, after the owner merges:
- the four checklist curls are green on production;
- `/api/health` shows the SHA;
- the owner reconnects claude.ai "Inbox";
- Claude Code `EmailCalendar` works;
- Mitra's A2A calls still succeed.

## Risks
- **Connected clients may need to reconnect.**
  - The exact redirect match can strand a client that cached a `client_id` registered with a different URI. It hits
    the error page and has to be reconnected by hand.
  - Clients without `aud` get one 401, then refresh.
- **CIMD is an outbound fetch to a URL the client chooses.** The SSRF guard and IP pinning are the defence, and each
  has its own test.
- **A2A tokens without `aud` stay accepted at `/mcp-server`** until they are reissued, and `/a2a` doesn't check client
  type. Both are recorded here and left for later.
