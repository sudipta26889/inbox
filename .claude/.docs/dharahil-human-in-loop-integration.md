# DharaHIL Human-in-the-Loop Integration Guide

## Overview

DharaHIL is a **Human-in-the-Loop (HITL) approval gateway** integrated into the Inbox system to intercept sensitive AI agent actions and route them to a human (Sudipta) for approval via Slack/Telegram before execution.

**Core Guarantee**: No calendar event with external attendees is created without explicit human approval.

## What is DharaHIL?

DharaHIL acts as a safety gate between AI agents and critical actions. When an AI agent wants to perform a sensitive operation (like creating a calendar event with external attendees, sending emails, etc.), it must:

1. **Submit** the proposed action to DharaHIL gateway
2. **Wait** for human approval via messaging app (Slack/Telegram)
3. **Execute** only if approved, or handle rejection/revision requests

### Architecture Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ AI Agent (MCP Server, Email Assistant, etc.)                   │
│  - Prepares action (create calendar event, send email, etc.)   │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ DharaHIL Client (TypeScript SDK)                                │
│  - beforeExecute(): Submit request to gateway                   │
│  - pollForDecision(): Wait for human response                   │
└────────────────────────────┬────────────────────────────────────┘
                             │ POST /v1/requests
                             │ {tool_name, tool_args, context}
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ DharaHIL Gateway (https://dharahil-gateway.sudiptadhara.in)    │
│  - Validates request                                            │
│  - Formats message for human                                    │
│  - Sends to Slack/Telegram                                       │
│  - Stores decision when human responds                          │
└────────────────────────────┬────────────────────────────────────┘
                             │ Slack/Telegram Message
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Human (Sudipta's Phone)                                         │
│  📱 Receives formatted notification with:                       │
│     - Action description                                        │
│     - Context summary                                           │
│     - Tool arguments (event details, email content, etc.)       │
│                                                                 │
│  Responds with:                                                 │
│     ✅ APPROVE - Allow the action                              │
│     ❌ REJECT  - Deny the action                               │
│     ✏️  REVISE  - Request changes with specific instructions   │
└────────────────────────────┬────────────────────────────────────┘
                             │ Decision stored in gateway
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ DharaHIL Client (Polling)                                       │
│  - GET /v1/requests/{id} every 3 seconds                        │
│  - Receives decision: APPROVED/REJECTED/REVISE_REQUESTED        │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ AI Agent - Takes Action Based on Decision:                     │
│  ✅ APPROVED → Execute the action                              │
│  ❌ REJECTED → Cancel, inform user                             │
│  ✏️  REVISE  → Read instructions, rebuild, re-submit           │
│  ⏱️  EXPIRED → Timeout, treat as rejected (safe default)       │
└─────────────────────────────────────────────────────────────────┘
```

## Configuration

### Environment Variables

```bash
# DharaHIL Gateway Configuration
DHARAHIL_BASE_URL=https://dharahil-gateway.sudiptadhara.in
DHARAHIL_API_KEY=dhara_sk_12f85b7abc1d1e23b83dd85c67e049271b91680edbc4d2787c59b42d8f83b6c9
DHARAHIL_TENANT_ID=0ff30ba6-44c0-4c1b-89e6-5936cca0cc29
DHARAHIL_APP_ID=69938d75-c4e7-4715-b575-0fb29da4b9ce
DHARAHIL_ENVIRONMENT=production

# Feature Toggle (Client-side)
NEXT_PUBLIC_DHARAHIL_ENABLED=true
```

### Gateway URL

**Primary Gateway**: `https://dharahil-gateway.sudiptadhara.in`

**API Endpoints**:
- Submit Request: `POST /v1/requests`
- Poll Decision: `GET /v1/requests/{request_id}`

### Client Initialization

The DharaHIL client is a singleton instance configured in `/apps/web/utils/dharahil/client.ts`:

```typescript
import { dharahilClient } from "@/utils/dharahil/client";

// Automatically configured from environment variables
// Can also be instantiated with custom config:
const client = new DharaHILClient({
  baseUrl: "https://dharahil-gateway.sudiptadhara.in",
  apiKey: "dhara_sk_...",
  tenantId: "0ff30ba6-...",
  appId: "69938d75-...",
  environment: "production",
});
```

## Usage Pattern

### 1. Standard Approval Flow

**Example**: Creating a calendar event with external attendees

```typescript
import { dharahilClient } from "@/utils/dharahil/client";
import { env } from "@/env";

async function createCalendarEvent(params: {
  title: string;
  startTime: string;
  endTime: string;
  attendees?: string[];
  description?: string;
  location?: string;
}) {
  const hasExternalAttendees = params.attendees?.some(email =>
    isExternalDomain(email)
  );

  // DharaHIL approval gate (only if enabled)
  if (env.NEXT_PUBLIC_DHARAHIL_ENABLED) {
    logger.info("DharaHIL: Requesting approval for calendar event creation");

    const decision = await dharahilClient.runApprovalLoop({
      toolName: "create_calendar_event",
      toolArgs: {
        title: params.title,
        startTime: params.startTime,
        endTime: params.endTime,
        attendees: params.attendees || [],
        description: params.description,
        location: params.location,
      },
      context: {
        agentId: "inbox-calendar-provider",
        runId: userId,
        stepId: "create_event",
        contextSummary: `Create calendar event: ${params.title} with ${params.attendees?.length || 0} attendees`,
        riskLevel: hasExternalAttendees ? "HIGH" : "MEDIUM",
        tags: ["calendar", "google", hasExternalAttendees ? "external" : "internal"],
        idempotencyKey: `calendar_${params.title}_${params.startTime}_${Date.now()}`,
        metadata: {
          provider: "google",
          title: params.title,
          attendee_count: String(params.attendees?.length || 0),
          has_external_attendees: hasExternalAttendees ? "true" : "false",
        },
      },
    });

    // Handle decision
    if (dharahilClient.wasDenied(decision)) {
      const errorMsg = decision.action === "EXPIRED"
        ? "Calendar event creation request timed out. The human approval window expired."
        : `Calendar event creation denied: ${decision.action}${decision.reason ? ` - ${decision.reason}` : ""}`;
      throw new Error(errorMsg);
    }

    if (dharahilClient.shouldRevise(decision)) {
      throw new Error(
        `Calendar event revision requested: ${decision.revise_input || "No specific instructions"}`
      );
    }

    logger.info("DharaHIL: Calendar event creation approved");
  }

  // Proceed with actual calendar event creation
  const event = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary: params.title,
      start: { dateTime: params.startTime },
      end: { dateTime: params.endTime },
      attendees: params.attendees?.map(email => ({ email })),
      description: params.description,
      location: params.location,
    },
  });

  return event;
}
```

### 2. Risk Level Classification

Risk levels determine urgency and TTL (Time-To-Live) for approval:

```typescript
type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

// Examples:
const riskLevel = determineRiskLevel({
  action: "create_calendar_event",
  hasExternalAttendees: true,
  hasExternalDomain: true,
  isAutomated: true,
});

function determineRiskLevel(context: {
  action: string;
  hasExternalAttendees: boolean;
  hasExternalDomain: boolean;
  isAutomated: boolean;
}): RiskLevel {
  // CRITICAL: External domains, automated actions with high impact
  if (context.hasExternalDomain && context.isAutomated) {
    return "CRITICAL";
  }

  // HIGH: External attendees, outbound emails, calendar invites
  if (context.hasExternalAttendees) {
    return "HIGH";
  }

  // MEDIUM: Internal actions with some impact
  if (context.action === "create_calendar_event") {
    return "MEDIUM";
  }

  // LOW: Read-only or low-impact actions
  return "LOW";
}
```

**Risk Level TTL Mapping** (configured in gateway):
- **LOW**: 30 minutes
- **MEDIUM**: 15 minutes
- **HIGH**: 5 minutes
- **CRITICAL**: 3 minutes

### 3. Handling Decisions

The client provides helper methods to interpret decisions:

```typescript
const decision = await dharahilClient.runApprovalLoop(request);

// Check if action should proceed
if (dharahilClient.shouldProceed(decision)) {
  // decision.action === "ALLOW" | "APPROVED" | "AUTO_ALLOWED"
  await executeAction();
}

// Check if action should be revised
if (dharahilClient.shouldRevise(decision)) {
  // decision.action === "REVISE_REQUESTED"
  const instructions = decision.revise_input;
  const reason = decision.reason;

  // Rebuild the action with revisions
  const revisedParams = await applyRevisions(originalParams, instructions);

  // Re-submit for approval
  const newDecision = await dharahilClient.runApprovalLoop({
    ...request,
    toolArgs: revisedParams,
  });
}

// Check if action was denied
if (dharahilClient.wasDenied(decision)) {
  // decision.action === "DENY" | "REJECTED" | "EXPIRED" | "ERROR"
  const reason = decision.reason || "No reason provided";
  logger.warn("Action denied", { action: decision.action, reason });
  throw new Error(`Action denied: ${reason}`);
}
```

## Decision Types and Handling

### APPROVED / ALLOW

**Meaning**: Human explicitly approved the action.

**Agent Action**:
- ✅ Execute the action as proposed
- Log successful approval
- Proceed with normal flow

```typescript
if (decision.action === "APPROVED" || decision.action === "ALLOW") {
  logger.info("Action approved by human", { requestId });
  await executeAction();
}
```

### REJECTED / DENY

**Meaning**: Human explicitly rejected the action.

**Agent Action**:
- ❌ Do NOT execute the action
- Log rejection with reason
- Inform user of denial
- Optionally surface reason to user

```typescript
if (decision.action === "REJECTED" || decision.action === "DENY") {
  logger.warn("Action rejected by human", {
    requestId,
    reason: decision.reason,
  });
  throw new Error(`Action rejected: ${decision.reason || "No reason provided"}`);
}
```

### REVISE_REQUESTED

**Meaning**: Human wants changes before approval.

**Agent Action**:
- ✏️ Read `revise_input` for specific instructions
- Rebuild the action with requested changes
- Re-submit to DharaHIL for approval
- May need AI to interpret revision instructions

```typescript
if (decision.action === "REVISE_REQUESTED") {
  logger.info("Revision requested", {
    instructions: decision.revise_input,
    reason: decision.reason,
  });

  // Option 1: Use AI to apply revisions
  const revisedParams = await applyRevisionsWithAI({
    original: originalParams,
    instructions: decision.revise_input,
  });

  // Option 2: Simple string replacements
  const revisedParams = {
    ...originalParams,
    description: decision.revise_input, // Direct override
  };

  // Re-submit
  const newDecision = await dharahilClient.runApprovalLoop({
    ...request,
    toolArgs: revisedParams,
    context: {
      ...request.context,
      contextSummary: `REVISED: ${request.context.contextSummary}`,
    },
  });

  // Handle the new decision
  if (dharahilClient.shouldProceed(newDecision)) {
    await executeAction(revisedParams);
  }
}
```

### EXPIRED

**Meaning**: Human did not respond within TTL window.

**Agent Action**:
- ⏱️ Treat as implicit REJECTION (safe default)
- Do NOT execute the action
- Log timeout
- Inform user that approval window expired

```typescript
if (decision.action === "EXPIRED") {
  logger.warn("Approval request timed out", { requestId });
  throw new Error(
    "Action timed out. The human approval window expired before a response was received. Please try again."
  );
}
```

**Why EXPIRED = REJECT**:
- **Fail-safe principle**: Better to block a legitimate action than allow a harmful one
- **No assumptions**: We cannot assume silence means approval
- **User can retry**: If action was important, user can try again

### AUTO_ALLOWED

**Meaning**: Gateway automatically approved (dev mode, bypass rules, etc.).

**Agent Action**:
- ✅ Execute the action
- Log that it was auto-allowed
- Typically only in development/testing

```typescript
if (decision.action === "AUTO_ALLOWED") {
  logger.info("Action auto-allowed by gateway policy", { requestId });
  await executeAction();
}
```

### ERROR

**Meaning**: Gateway unreachable, network failure, or other error.

**Agent Action**:
- ❌ Treat as REJECTION (fail-safe)
- Do NOT execute the action
- Log error details
- Alert developers if persistent

```typescript
if (decision.action === "ERROR") {
  logger.error("DharaHIL gateway error", {
    requestId,
    error: decision.reason,
  });
  throw new Error(
    `DharaHIL gateway error: ${decision.reason}. Action blocked for safety.`
  );
}
```

## TTL (Time-To-Live) Management

### How TTL Works

1. **Gateway returns `expires_at`**: When you submit a request, the gateway responds with an ISO-8601 timestamp indicating when the request will expire.

   ```json
   {
     "request_id": "req_abc123",
     "expires_at": "2026-03-22T12:45:00Z",
     "status": "PENDING"
   }
   ```

2. **Client calculates dynamic timeout**: The client uses this timestamp to determine how long to poll.

   ```typescript
   const expiresAtTime = new Date(expiresAt).getTime();
   const now = Date.now();
   const dynamicTimeoutMs = expiresAtTime - now;
   ```

3. **Polling loop**: Client polls `GET /v1/requests/{id}` every 3 seconds until:
   - Decision is received (APPROVED/REJECTED/REVISE_REQUESTED)
   - TTL expires → return EXPIRED
   - Network error → continue polling (transient failures are retried)

4. **No decision by expiry**: If `expires_at` is reached with no decision, return `{ action: "EXPIRED" }`.

### TTL Configuration

TTLs are configured **in the gateway**, not the client. The gateway determines TTL based on:
- **Risk level** (HIGH = shorter TTL, LOW = longer TTL)
- **Action type** (email send vs calendar create)
- **Tenant/app policies**

**Typical TTL values**:
```typescript
const TTL_BY_RISK_LEVEL = {
  CRITICAL: 3 * 60 * 1000,   // 3 minutes
  HIGH: 5 * 60 * 1000,       // 5 minutes
  MEDIUM: 15 * 60 * 1000,    // 15 minutes
  LOW: 30 * 60 * 1000,       // 30 minutes
};
```

### Polling Interval

Default: **3 seconds**

```typescript
await dharahilClient.pollForDecision(
  requestId,
  expiresAt,
  3000  // pollIntervalMs
);
```

**Why 3 seconds?**
- Fast enough for responsive UX (human approves on phone, agent continues within seconds)
- Not too aggressive to overload gateway
- Balances latency vs server load

## Message Format (What Human Sees)

When DharaHIL sends a message to Slack/Telegram, it formats it for human readability:

### Example: Calendar Event Creation

```
🔔 Action Approval Required

Tool: create_calendar_event
Risk Level: HIGH 🔴
Agent: inbox-calendar-provider

Context:
Create calendar event: Weekly Team Sync with 5 attendees

Details:
  Title: Weekly Team Sync
  Start: 2026-03-24T14:00:00Z
  End: 2026-03-24T15:00:00Z
  Attendees:
    - alice@external-company.com
    - bob@external-company.com
    - charlie@internal.com
  Location: Zoom Meeting Room
  Description: Discuss Q1 roadmap and priorities

Tags: calendar, google, external

Respond:
✅ APPROVE - Allow this action
❌ REJECT - Deny this action
✏️ REVISE <instructions> - Request changes

Request ID: req_abc123
Expires in: 5 minutes
```

### Example: Email Send

```
🔔 Action Approval Required

Tool: send_email
Risk Level: CRITICAL 🔴
Agent: email-assistant

Context:
Send email to external client (alice@client.com)

Details:
  To: alice@client.com
  Subject: Re: Project Proposal - Next Steps
  Body: Hi Alice,

  Thank you for the proposal. I've reviewed it and have a few questions...

  Best regards,
  Sudipta

Tags: email, send, external, automated

Respond:
✅ APPROVE
❌ REJECT
✏️ REVISE <changes>

Request ID: req_xyz789
Expires in: 3 minutes
```

## Advanced Usage

### Custom Polling Interval

For time-sensitive actions, adjust polling interval:

```typescript
const decision = await dharahilClient.pollForDecision(
  requestId,
  expiresAt,
  1000  // Poll every 1 second (more responsive)
);
```

### Idempotency Keys

Prevent duplicate submissions:

```typescript
const idempotencyKey = `calendar_event_${eventId}_${timestamp}`;

const decision = await dharahilClient.runApprovalLoop({
  toolName: "create_calendar_event",
  toolArgs: params,
  context: {
    ...context,
    idempotencyKey,  // Dedup in gateway
  },
});
```

If the same `idempotencyKey` is submitted multiple times:
- Gateway returns the existing request's status
- No new Slack/Telegram message sent
- Human sees only one approval request

### Metadata for Context

Attach additional metadata for logging/analytics:

```typescript
const decision = await dharahilClient.runApprovalLoop({
  toolName: "create_calendar_event",
  toolArgs: params,
  context: {
    ...context,
    metadata: {
      provider: "google",
      calendar_id: "primary",
      user_email: "sudipta@example.com",
      client_name: "Acme Corp",
      project_id: "proj_123",
      is_recurring: "false",
    },
  },
});
```

This metadata:
- Appears in gateway logs
- Can be used for analytics
- Helps debug issues
- Does NOT appear in Slack/Telegram message (keeps it concise)

### Tags for Filtering

Use tags to categorize requests:

```typescript
const decision = await dharahilClient.runApprovalLoop({
  toolName: "send_email",
  toolArgs: emailParams,
  context: {
    ...context,
    tags: [
      "email",
      "send",
      "external",
      "automated",
      "urgent",
      `to:${recipientDomain}`,
    ],
  },
});
```

Tags enable:
- Filtering in gateway dashboard
- Different TTL rules per tag
- Analytics/reporting
- Policy routing (e.g., "urgent" → shorter TTL)

## Error Handling

### Network Failures

The client implements retry logic for transient errors:

```typescript
async pollForDecision(requestId, expiresAt) {
  while (Date.now() < expiresAtTime) {
    try {
      const response = await fetch(`${baseUrl}/v1/requests/${requestId}`);
      // ... process response
    } catch (error) {
      logger.error("Polling error", { error });
      // Continue polling on transient errors
      await sleep(pollIntervalMs);
    }
  }
}
```

**Behavior**:
- Transient network errors → Keep polling
- Gateway 5xx errors → Keep polling
- Timeout reached → Return EXPIRED

### Gateway Unreachable

If the gateway is completely unreachable during submission:

```typescript
try {
  const response = await dharahilClient.beforeExecute(request);
} catch (error) {
  logger.error("DharaHIL gateway unreachable", { error });
  // Fail-safe: Deny action
  throw new SafeError(
    "DharaHIL gateway unreachable - action denied for safety"
  );
}
```

**Fail-safe principle**: If we can't reach the gateway, **deny the action** rather than auto-allowing it.

### Invalid Gateway Response

If the gateway returns an unexpected response:

```typescript
if (!data.request_id || !data.expires_at) {
  logger.error("Invalid response from gateway", { data });
  throw new SafeError(
    "DharaHIL gateway returned invalid response"
  );
}
```

## Testing DharaHIL Integration

### Development Mode

When `NEXT_PUBLIC_DHARAHIL_ENABLED=false`:
- DharaHIL approval is completely bypassed
- Actions execute immediately
- Useful for local development

```typescript
if (env.NEXT_PUBLIC_DHARAHIL_ENABLED) {
  const decision = await dharahilClient.runApprovalLoop(request);
  // ... handle decision
} else {
  logger.info("DharaHIL disabled, proceeding without approval");
}
```

### Testing with Real Gateway

1. Set `NEXT_PUBLIC_DHARAHIL_ENABLED=true`
2. Configure valid gateway credentials
3. Ensure your phone has Slack/Telegram set up
4. Trigger an action (create calendar event)
5. Check phone for approval message
6. Respond with APPROVE/REJECT/REVISE
7. Verify agent receives decision and acts accordingly

### Testing TTL Expiry

To test timeout handling:

1. Submit a request with HIGH risk (5-minute TTL)
2. Do NOT respond on phone
3. Wait for expiry
4. Verify agent receives EXPIRED decision
5. Verify action was NOT executed

### Testing REVISE Flow

1. Submit a calendar event creation
2. On phone, respond: `REVISE Change title to "Team Meeting" and add agenda`
3. Verify agent receives `REVISE_REQUESTED` with `revise_input`
4. Verify agent applies changes and re-submits
5. Approve the revised request
6. Verify action executes with changes

## Best Practices

### 1. Always Check Feature Toggle

```typescript
if (env.NEXT_PUBLIC_DHARAHIL_ENABLED) {
  // DharaHIL approval flow
} else {
  // Direct execution (dev mode)
}
```

### 2. Use Descriptive Context Summaries

Bad:
```typescript
contextSummary: "Create event"
```

Good:
```typescript
contextSummary: `Create calendar event: "${params.title}" with ${attendeeCount} attendees (${hasExternal ? 'EXTERNAL' : 'internal'})`
```

### 3. Set Appropriate Risk Levels

```typescript
const riskLevel = hasExternalAttendees ? "HIGH" : "MEDIUM";
```

Don't over-escalate (everything as CRITICAL) or under-escalate (everything as LOW).

### 4. Handle All Decision Types

Always implement handlers for:
- ✅ APPROVED → Execute
- ❌ REJECTED → Cancel + inform user
- ✏️ REVISE → Apply changes + re-submit
- ⏱️ EXPIRED → Timeout message
- ⚠️ ERROR → Log + fail-safe

### 5. Provide Clear Error Messages

```typescript
if (decision.action === "EXPIRED") {
  throw new Error(
    "Calendar event creation request timed out. The human approval window expired before a response was received. Please try again."
  );
}
```

User-friendly, actionable error messages.

### 6. Log Everything

```typescript
logger.info("DharaHIL: Requesting approval", { toolName, riskLevel });
logger.info("DharaHIL: Decision received", { action: decision.action });
logger.warn("DharaHIL: Action denied", { reason: decision.reason });
```

Comprehensive logging helps debug issues and understand approval patterns.

### 7. Use Idempotency Keys

For actions that might be retried:

```typescript
idempotencyKey: `${toolName}_${uniqueIdentifier}_${timestamp}`
```

Prevents duplicate Slack/Telegram messages if the client retries.

## Troubleshooting

### Issue: No message received on phone

**Check**:
1. Is `NEXT_PUBLIC_DHARAHIL_ENABLED=true`?
2. Are gateway credentials correct? (API key, tenant ID, app ID)
3. Is the gateway URL correct? (`https://dharahil-gateway.sudiptadhara.in`)
4. Check gateway logs for message delivery status
5. Verify phone number is registered in gateway settings

### Issue: Request times out immediately

**Check**:
1. Verify `expires_at` timestamp in gateway response
2. Check system clock (if server time is wrong, TTL calculation fails)
3. Verify gateway is returning valid ISO-8601 timestamp

### Issue: Decision not received despite approval

**Check**:
1. Verify polling loop is active (check logs for "Polling" messages)
2. Check if decision was stored in gateway (GET /v1/requests/{id})
3. Verify request_id matches between submit and poll
4. Check for network errors in polling loop

### Issue: REVISE not working

**Check**:
1. Verify `decision.revise_input` is populated
2. Check if revision logic is implemented correctly
3. Verify re-submission uses updated `toolArgs`
4. Check if revision instructions are clear/parseable

## Security Considerations

### 1. API Key Protection

**Never expose API key in client-side code**:
- ✅ DharaHIL client is server-only (`import "server-only"`)
- ✅ API key in environment variables
- ❌ Do NOT send API key to browser

### 2. Fail-Safe Defaults

- Gateway unreachable → DENY (not AUTO_ALLOW)
- Timeout → EXPIRED → DENY
- Error → ERROR → DENY

**Philosophy**: Better to block a legitimate action than allow a harmful one.

### 3. Audit Trail

All requests are logged:
- Who requested (userId, agentId)
- What action (toolName, toolArgs)
- When (timestamp)
- Decision (APPROVED/REJECTED/etc.)
- Human who decided

Gateway maintains full audit trail for compliance.

### 4. PII Redaction

**Current**: `tool_args_redacted` is same as `tool_args` (TODO)

**Future**: Redact sensitive fields:
```typescript
tool_args_redacted: {
  ...toolArgs,
  email_body: "<REDACTED>",
  password: "<REDACTED>",
  credit_card: "<REDACTED>",
}
```

## Current Integrations

### Calendar Event Creation

**File**: `/apps/web/utils/mcp-server/tools/calendar-tools.ts`

**When**: Creating calendar events with external attendees

**Risk Level**: HIGH

**TTL**: ~5 minutes

### Email Sending (Future)

**Planned**: Send email via MCP tools

**When**: Sending outbound emails, especially to external domains

**Risk Level**: CRITICAL (external) / HIGH (internal)

**TTL**: 3-5 minutes

## Future Enhancements

### 1. Conditional Approval Based on Rules

Gateway could auto-approve certain patterns:
- Internal meetings with < 5 attendees → AUTO_ALLOWED
- Emails to whitelisted domains → AUTO_ALLOWED
- Recurring events (already approved) → AUTO_ALLOWED

### 2. Multiple Approvers

Support for team approvals:
- Require 2-of-3 approvals for CRITICAL actions
- Escalation if primary approver doesn't respond

### 3. Async Webhook Callbacks

Instead of polling, use webhooks:
- Gateway calls webhook when decision is made
- Faster response time
- Reduces server load

### 4. Rich Message Formatting

- Inline preview of calendar invite
- Email preview with formatting
- Interactive buttons (not just text responses)

### 5. Analytics Dashboard

- Approval rates by action type
- Average response time
- Most common rejections
- Trend analysis

## Summary

DharaHIL provides a **robust, fail-safe human-in-the-loop approval mechanism** for sensitive AI agent actions. Key features:

✅ **Simple Integration**: One function call (`runApprovalLoop()`)
✅ **Fail-Safe**: Errors/timeouts → DENY (never auto-allow)
✅ **Three-Way Decisions**: APPROVE / REJECT / REVISE
✅ **Dynamic TTL**: Gateway determines timeout based on risk
✅ **Idempotency**: Prevents duplicate approval requests
✅ **Comprehensive Logging**: Full audit trail
✅ **Slack/Telegram**: Approve from your phone anywhere

**Current Status**: Fully integrated for calendar event creation. Ready to expand to email sending, file operations, and other sensitive actions.
