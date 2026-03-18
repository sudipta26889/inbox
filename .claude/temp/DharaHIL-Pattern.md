# DharaHIL Pattern — Human-in-the-Loop Gateway

> Battle-tested from the OpenClaw/Upwork automation system.  
> This doc gives a new implementer everything they need to wire DharaHIL into any agentic app — specifically Email & Calendar managers.

---

## What is DharaHIL?

DharaHIL is a **Human-in-the-Loop (HITL) gateway** that intercepts AI agent actions _before_ they execute and routes them to a human for approval via WhatsApp (or any messaging channel). The human's response — APPROVE, REJECT, or REVISE — is the gate.

**Core promise:** The agent never sends an email or creates a calendar event without Sudipta's explicit thumbs-up.

---

## Architecture Overview

```
Agent prepares action
        │
        ▼
DharaHILClient.before_execute()
        │  POST /v1/requests  (tool_name, tool_args, context)
        ▼
DharaHIL Gateway
        │  sends formatted message to WhatsApp/Telegram
        ▼
Human sees message on phone
        │  replies: APPROVE / REJECT / REVISE (with text)
        ▼
Gateway stores decision
        │
        ▼
Agent polls GET /v1/requests/{id}  every 3s
        │  until decision appears OR TTL expires
        ▼
Agent reads action: ALLOW | DENY | REVISE_REQUESTED | EXPIRED
        │
        ├─ ALLOW / APPROVED  → execute the action
        ├─ DENY / REJECTED   → skip / discard
        ├─ EXPIRED           → treat as REJECT (safe default)
        └─ REVISE_REQUESTED  → read revise_input, rebuild draft, loop again
```

---

## Decision States

| State | Meaning | Agent Behaviour |
|---|---|---|
| `ALLOW` / `APPROVED` | Human said yes | Execute the action |
| `DENY` / `REJECTED` | Human said no | Discard — log reason |
| `REVISE_REQUESTED` | Human gave instructions | Read `revise_input`, regenerate, re-submit to DharaHIL |
| `EXPIRED` | No reply within TTL | Treat as REJECT — never auto-send on timeout |
| `AUTO_ALLOWED` | Policy bypassed (e.g., dev mode) | Execute — gateway decided, no human needed |
| `ERROR` | Gateway/network failure | Treat as REJECT — fail safe |

---

## TTL — Time-To-Live

**TTL = the maximum time the agent waits for a human decision before auto-failing.**

### How it works

1. When the agent POSTs to `/v1/requests`, the gateway returns `expires_at` (ISO-8601 timestamp).
2. The client polls every `poll_interval_seconds` (default: 3s).
3. If `expires_at` is reached with no decision → raises `TimeoutError` → action = `EXPIRED`.
4. `EXPIRED` is always treated as **REJECT** — the action is not executed.

### TTL values by action type

| Action | Recommended TTL | Rationale |
|---|---|---|
| Send email (outbound) | **10 minutes** | Emails can wait; prevents rushed sends |
| Send email (reply to client) | **5 minutes** | Client is waiting; tighter window |
| Create calendar event (internal) | **15 minutes** | No external impact |
| Create calendar event (external invite) | **5 minutes** | Invitee expects prompt response |
| Delete / cancel event | **3 minutes** | Irreversible — needs fast human check |

### TTL configuration

```python
result = await client.run_approval_loop(
    tool_name=tool_name,
    tool_args=tool_args,
    context=context,
    poll_interval_seconds=3.0,
    # TTL comes from gateway expires_at by default.
    # Override if needed:
    timeout_seconds=300,   # 5 minutes hard override
)
```

If DharaHIL is unreachable, the client falls back to `AUTO_ALLOWED` so the agent doesn't deadlock — **override this default to DENY for production email/calendar**.

---

## Message Format — What the Human Sees

Design the WhatsApp/Telegram message to be scannable in 5 seconds on a phone.

### Email HITL message template

```
📧 EMAIL — REVIEW BEFORE SENDING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▸ TO:      alice@acme.com
▸ SUBJECT: Follow-up: RAG pipeline proposal
▸ PREVIEW: Hi Alice, Following up on our discussion
           yesterday about the document ingestion...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HOW TO REPLY:
  ✅  APPROVE  →  send as-is
  ❌  REJECT   →  discard
  ✏️  any text →  revise (e.g. "Change tone to formal"
                   or "Add our pricing in paragraph 2")
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⏱️ 10 min timeout — no reply = email NOT sent
```

### Calendar HITL message template

```
📅 CALENDAR EVENT — REVIEW BEFORE CREATING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▸ TITLE:    Discovery Call — Alice / Acme Corp
▸ WHEN:     Thu Mar 19, 2026 · 3:00 PM – 4:00 PM IST
▸ WITH:     alice@acme.com
▸ LOCATION: Google Meet (link auto-generated)
▸ NOTES:    Discuss RAG pipeline scope and timeline

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HOW TO REPLY:
  ✅  APPROVE  →  create & send invite
  ❌  REJECT   →  discard
  ✏️  any text →  revise (e.g. "Move to Friday 4PM"
                   or "Remove Google Meet, use Zoom")
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⏱️ 5 min timeout — no reply = event NOT created
```

---

## The Revise Loop — RETHINK + RE-DO

This is the most important pattern. REJECT is binary. REVISE is a dialogue.

### Flow

```
Agent → DharaHIL → Human replies: "Change subject to: Project Update Q1"
                                                    │
                                         action = REVISE_REQUESTED
                                         revise_input = "Change subject to: Project Update Q1"
                                                    │
                              Agent reads revise_input
                              Agent regenerates draft with changes
                              Agent re-submits to DharaHIL (new request)
                                                    │
                                         Human sees updated draft
                                         Human replies: APPROVE
                                                    │
                                         Agent sends email ✅
```

### Implementation

```python
async def send_email_with_hitl(draft: dict, client: DharaHILClient, max_revisions: int = 3):
    """
    max_revisions: safety cap — prevents infinite revision loops.
    """
    current_draft = draft
    revision_count = 0

    while revision_count <= max_revisions:
        tool_args = {
            "to": current_draft["to"],
            "subject": current_draft["subject"],
            "body": current_draft["body"],
        }
        context = {
            "context_summary": format_email_preview(current_draft),
            "risk_level": "HIGH",
            "agent_id": "email-manager",
            "run_id": str(uuid.uuid4()),
            "step_id": f"email_approve_v{revision_count + 1}",
        }

        try:
            result = await client.run_approval_loop(
                tool_name="send_email",
                tool_args=tool_args,
                context=context,
                poll_interval_seconds=3.0,
                timeout_seconds=600,
            )
        except TimeoutError:
            result = {"action": "EXPIRED"}

        action = result.get("action", "EXPIRED")

        if action in ("ALLOW", "APPROVED", "AUTO_ALLOWED"):
            await execute_send_email(current_draft)
            return {"sent": True, "revisions": revision_count}

        elif action == "REVISE_REQUESTED":
            revise_input = result.get("revise_input", "")
            if not revise_input:
                # Treat empty revise as reject
                return {"sent": False, "reason": "empty_revise"}
            revision_count += 1
            if revision_count > max_revisions:
                # Too many loops — surface to human via a final message
                await notify_human("Max revisions reached. Email discarded.")
                return {"sent": False, "reason": "max_revisions"}
            # Re-generate draft using human's instructions
            current_draft = await llm_revise_draft(current_draft, revise_input)

        else:
            # DENY, REJECTED, EXPIRED, ERROR
            return {"sent": False, "reason": action}
```

### Revision version guard

When polling after a revision, pass `after_version` to ignore stale decisions:

```python
decision = await client.wait_for_decision(
    request_id,
    poll_interval_seconds=3.0,
    after_version=revision_count,  # ignore decisions from previous round
)
```

---

## Context Object — What to Send

```python
context = {
    # Short text shown in approval card (even when body is redacted)
    "context_summary": "Send email to alice@acme.com re: RAG pipeline proposal",

    # Risk level controls urgency display in approval UI
    # LOW | MEDIUM | HIGH | CRITICAL
    "risk_level": "HIGH",

    # Which agent is acting (for audit trail)
    "agent_id": "email-manager",

    # Unique per pipeline run (for idempotency)
    "run_id": str(uuid.uuid4()),

    # Which step within the run (for audit trail)
    "step_id": "send_email_step_1",

    # Prevents duplicate approvals if agent retries
    "idempotency_key": f"email_{thread_id}_{attempt}",

    # Optional: surface extra info in approval UI
    "metadata": {
        "email_thread_id": thread_id,
        "client_name": "Alice / Acme Corp",
        "draft_version": 1,
    },
}
```

---

## Email Manager — Full Integration Pattern

```python
# email_manager/hitl.py

from dharahil.client import DharaHILClient

class EmailHITL:
    def __init__(self, client: DharaHILClient):
        self.client = client

    async def approve_and_send(self, draft: dict) -> dict:
        """
        Intercepts email sending. Returns:
        {"sent": True/False, "reason": str, "revisions": int}
        """
        return await send_email_with_hitl(
            draft=draft,
            client=self.client,
            max_revisions=3,
        )

    def format_message(self, draft: dict) -> str:
        """Build the WhatsApp preview message."""
        body_preview = draft["body"][:200].replace("\n", " ")
        return (
            f"📧 EMAIL — REVIEW BEFORE SENDING\n{'━'*30}\n"
            f"▸ TO:      {draft['to']}\n"
            f"▸ SUBJECT: {draft['subject']}\n"
            f"▸ PREVIEW: {body_preview}...\n\n"
            f"{'━'*30}\n"
            "HOW TO REPLY:\n"
            "  ✅  APPROVE  →  send as-is\n"
            "  ❌  REJECT   →  discard\n"
            "  ✏️  any text →  revise\n"
            f"{'━'*30}\n"
            "⏱️ 10 min timeout — no reply = NOT sent"
        )
```

---

## Calendar Manager — Full Integration Pattern

```python
# calendar_manager/hitl.py

class CalendarHITL:
    def __init__(self, client: DharaHILClient):
        self.client = client

    async def approve_and_create(self, event: dict) -> dict:
        """
        event = {
            "title": str, "start": ISO datetime, "end": ISO datetime,
            "attendees": [str], "location": str, "description": str,
            "send_invite": bool  # whether to email attendees
        }
        """
        # Higher risk if external invite — tighter TTL
        ttl = 300 if event.get("send_invite") else 900

        tool_args = {
            "title": event["title"],
            "start": event["start"],
            "end": event["end"],
            "attendees": event["attendees"],
            "location": event.get("location", ""),
            "description": event.get("description", ""),
            "send_invite": event.get("send_invite", False),
        }
        context = {
            "context_summary": self._summary(event),
            "risk_level": "HIGH" if event.get("send_invite") else "MEDIUM",
            "agent_id": "calendar-manager",
            "run_id": str(uuid.uuid4()),
            "step_id": "create_event",
            "idempotency_key": f"cal_{event['title']}_{event['start']}",
        }

        revision_count = 0
        current_event = event

        while revision_count <= 3:
            try:
                result = await self.client.run_approval_loop(
                    tool_name="create_calendar_event",
                    tool_args=tool_args,
                    context=context,
                    timeout_seconds=ttl,
                    poll_interval_seconds=3.0,
                )
            except TimeoutError:
                result = {"action": "EXPIRED"}

            action = result.get("action", "EXPIRED")

            if action in ("ALLOW", "APPROVED", "AUTO_ALLOWED"):
                await execute_create_event(current_event)
                return {"created": True, "revisions": revision_count}

            elif action == "REVISE_REQUESTED":
                revise_input = result.get("revise_input", "")
                revision_count += 1
                current_event = await llm_revise_event(current_event, revise_input)
                tool_args = build_tool_args(current_event)
            else:
                return {"created": False, "reason": action}

        return {"created": False, "reason": "max_revisions"}

    def _summary(self, event: dict) -> str:
        return (
            f"Create: {event['title']}\n"
            f"When: {event['start']} → {event['end']}\n"
            f"With: {', '.join(event.get('attendees', []))}"
        )
```

---

## Client Initialisation

```python
# Secrets from vault — never hardcode
client = DharaHILClient(
    base_url=os.getenv("DHARAHIL_BASE_URL"),
    api_key=os.getenv("DHARAHIL_API_KEY"),
    tenant_id=os.getenv("DHARAHIL_TENANT_ID"),
    app_id=os.getenv("DHARAHIL_APP_ID"),
    environment=os.getenv("DHARAHIL_ENVIRONMENT", "production"),
)
```

Required env vars (sync to ALL surfaces: `.env`, `.env.example`, docker-compose, CI):

```
DHARAHIL_BASE_URL=https://your-gateway.example.com
DHARAHIL_API_KEY=your-api-key
DHARAHIL_TENANT_ID=your-tenant
DHARAHIL_APP_ID=email-calendar-manager
DHARAHIL_ENVIRONMENT=production
```

---

## Fail-Safe Rules (Non-Negotiable)

| Scenario | Safe Default |
|---|---|
| DharaHIL gateway unreachable | **DENY** — never auto-send |
| `EXPIRED` (TTL reached, no reply) | **DENY** — never auto-send |
| `revise_input` is empty string | **DENY** — ambiguous instruction |
| Revision count > `max_revisions` | **DENY** — notify human, discard |
| Gateway returns unexpected action | **DENY** — unknown = unsafe |
| Exception during `run_approval_loop` | **DENY** — fail closed |

**The golden rule: when in doubt, do nothing.** The human can always trigger a retry. A wrongly-sent email cannot be unsent.

---

## What NOT to Send Through DharaHIL

DharaHIL is for **irreversible outbound actions**. Don't HITL everything — it creates alert fatigue.

| Action | HITL? | Reason |
|---|---|---|
| Send outbound email | ✅ YES | Irreversible, external |
| Reply to client message | ✅ YES | Represents you externally |
| Create event with external invite | ✅ YES | Irreversible, external |
| Create internal reminder (no invite) | ⚠️ Optional | Reversible |
| Read/summarise emails | ❌ NO | Read-only |
| Draft email (not send) | ❌ NO | Not yet executed |
| Update internal notes | ❌ NO | No external impact |
| Archive / label emails | ❌ NO | Reversible |

---

## Summary Checklist for New Implementer

- [ ] Deploy DharaHIL gateway (or use existing instance)
- [ ] Set all 5 env vars across all config surfaces
- [ ] Import `DharaHILClient` from `dharahil.client`
- [ ] Wrap every outbound action (send_email, create_event) with `run_approval_loop`
- [ ] Set TTL: 10 min for email, 5 min for external calendar invite
- [ ] Implement REVISE loop with `max_revisions=3` safety cap
- [ ] Use `after_version` when polling after a revision
- [ ] All error/timeout paths → DENY (fail closed)
- [ ] Format WhatsApp message: TO / SUBJECT / PREVIEW / reply instructions / TTL warning
- [ ] Idempotency key on every request to prevent duplicate sends on agent retry
