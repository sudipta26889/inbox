# Generic SDK & Rich Notifications Design

**Date:** 2026-02-22
**Status:** Draft

## Problem

DharaHIL works for the Slack agent but cannot scale to arbitrary agent types (email, LinkedIn, CRM, export business tools) without hardcoded changes. Approvers see raw JSON instead of structured, human-friendly notifications. The policy engine cannot gate on domain-specific attributes.

## Goals

1. Any agent developer integrates DharaHIL with 3-5 lines of setup
2. Telegram notifications show domain-specific context (not raw JSON)
3. Policy engine matches on arbitrary agent metadata
4. Zero breaking changes to existing agents — all new fields are optional

## Design

### 1. Tool Context Envelope

The SDK sends three layers of data per tool call:

| Layer | Type | Purpose | Consumer |
|-------|------|---------|----------|
| `context_summary` | `str` | Human-readable one-liner | Shown everywhere as fallback |
| `metadata` | `Dict[str, str]` | Flat key-value pairs for policy matching | Policy engine |
| `display` | `DisplayHints` | Rendering instructions: sections, field labels, types | Worker/UI notifications |

#### ToolContext Dataclass

```python
@dataclass
class ToolContext:
    agent_id: str
    run_id: str
    step_id: str = "step"
    risk_level: str = "MEDIUM"
    tags: list[str] = field(default_factory=list)
    context_summary: str = ""
    idempotency_key: str = ""
    decision_url: str = ""
    metadata: dict[str, str] = field(default_factory=dict)
    display: DisplayHints | None = None
```

#### DisplayHints

```python
@dataclass
class DisplayHints:
    title: str = ""           # e.g. "Post message in #sales"
    category: str = ""        # e.g. "communication", "data_access", "social"
    sections: list[dict] = field(default_factory=list)
    # Each section: {"label": "Destination", "fields": [{"key": "channel", "label": "Channel", "type": "text"}]}
    # Field types: "text" (default), "code", "url", "email", "markdown", "json"
```

### 2. SDK Integration Examples

**Slack Agent:**
```python
client = DharaHILClient(base_url=..., api_key=..., tenant_id=..., app_id=..., environment="production")

result = await client.before_execute(
    tool_name="send_slack_message",
    tool_args={"channel": "#sales", "text": "Weekly update..."},
    context=ToolContext(
        agent_id="slack-bot", run_id="run-123",
        context_summary="User requested weekly update post",
        risk_level="MEDIUM",
        tags=["communication", "slack"],
        metadata={"workspace": "acme", "channel_type": "public", "has_external_members": "false"},
        display=DisplayHints(
            title="Post message in #sales",
            category="communication",
            sections=[
                {"label": "Destination", "fields": [{"key": "channel", "label": "Channel"}]},
                {"label": "Content", "fields": [{"key": "text", "label": "Message", "type": "markdown"}]},
            ],
        ),
    ),
)
```

**Email Agent:**
```python
result = await client.before_execute(
    tool_name="send_email",
    tool_args={"to": "client@external.com", "subject": "Proposal", "body": "..."},
    context=ToolContext(
        agent_id="email-bot", run_id="run-456",
        context_summary="Sending proposal to external client",
        risk_level="HIGH",
        tags=["communication", "email", "external"],
        metadata={"recipient_domain": "external.com", "has_attachment": "false"},
        display=DisplayHints(
            title="Send email to client@external.com",
            category="communication",
            sections=[
                {"label": "Recipients", "fields": [{"key": "to", "label": "To", "type": "email"}]},
                {"label": "Email", "fields": [
                    {"key": "subject", "label": "Subject"},
                    {"key": "body", "label": "Body", "type": "markdown"},
                ]},
            ],
        ),
    ),
)
```

**LinkedIn Agent:**
```python
result = await client.before_execute(
    tool_name="linkedin_send_connection",
    tool_args={"profile_url": "linkedin.com/in/john", "note": "Hi John..."},
    context=ToolContext(
        agent_id="linkedin-bot", run_id="run-789",
        context_summary="Connecting with potential export partner",
        risk_level="LOW",
        tags=["social", "linkedin"],
        metadata={"connection_degree": "2nd", "industry": "manufacturing"},
        display=DisplayHints(
            title="Connect with John Smith on LinkedIn",
            category="social",
            sections=[
                {"label": "Profile", "fields": [{"key": "profile_url", "label": "Profile", "type": "url"}]},
                {"label": "Message", "fields": [{"key": "note", "label": "Connection Note", "type": "markdown"}]},
            ],
        ),
    ),
)
```

### 3. Gateway API Changes

**CreateRequestBody** — add optional fields:

```python
class CreateRequestBody(BaseModel):
    # ... existing fields (all unchanged) ...
    metadata: Dict[str, str] = {}              # NEW
    display_hints: Optional[Dict] = None       # NEW
```

Both default to empty/null so existing SDK versions keep working.

### 4. Database Changes

**ApprovalRequest** — add `metadata` column:

```python
metadata: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
```

Rationale: metadata is set once at creation and used by the policy engine. It doesn't change across versions.

**ApprovalRequestVersion** — add `display_hints` column:

```python
display_hints: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
```

Rationale: display hints may change when the agent revises its proposal (e.g., different title after revision).

One Alembic migration. Nullable columns, no data loss.

### 5. Policy Engine — Metadata Matching

Current matching: `tool_name`, `environment`, `min_risk`, `tags`.

New: rules can include `metadata.*` keys for exact string equality matching.

```json
{
  "rules": [
    {
      "match": {
        "tool_name": "send_email",
        "metadata.recipient_domain": "external.com"
      },
      "action": "REQUIRE_APPROVAL"
    },
    {
      "match": {
        "tool_name": "linkedin_connect",
        "metadata.connection_degree": "1st"
      },
      "action": "ALLOW"
    }
  ],
  "default": {"action": "REQUIRE_APPROVAL"}
}
```

Implementation in `policy_engine.py`:
- Any match key starting with `metadata.` extracts the suffix and looks it up in the request's metadata dict
- Exact string equality only (no regex, no operators)
- Missing metadata key = no match (rule skipped)

### 6. Notification Rendering

**Worker Telegram notifications** read `display_hints` from the latest version:

1. If `display_hints.title` exists, use it as the action title instead of raw `tool_name`
2. If `display_hints.sections` exist, render fields grouped by section with labels
3. If no display hints, fall back to current behavior (raw `tool_args` key-value dump)
4. Always include a deep link: `🔗 [View in Dashboard]({UI_BASE_URL}/inbox/{request_id})`

**Rendering rules per field type:**
- `text` (default): inline as-is
- `code`: wrap in backticks
- `url`: render as clickable link
- `email`: render as `mailto:` link (Telegram supports this)
- `markdown`: render inline (Telegram Markdown V1)
- `json`: format as code block

### 7. Backward Compatibility

| Component | Old behavior | New behavior | Breaking? |
|-----------|-------------|--------------|-----------|
| SDK `before_execute(context=dict)` | Dict with known keys | Also accepts ToolContext dataclass | No — dict still works |
| Gateway `POST /v1/requests` | No metadata/display | Accepts optional metadata/display_hints | No — optional fields |
| Policy rules | Match on 4 fields | Also match on metadata.* keys | No — old rules unchanged |
| Telegram notification | Raw tool_args dump | Display hints if present, else raw dump | No — fallback to old |
| Existing data in DB | No metadata/display_hints columns | New nullable columns with defaults | No — migration adds columns |

### 8. Out of Scope (Future)

- Multi-approver / quorum support
- Sampling rate in policy rules
- Server-side risk inference from tool_args
- Slack/email notification channels
- CloudEvents webhook format
- Tool schema registry (gateway-side)
- Auto-action on timeout (auto-approve/auto-reject)
