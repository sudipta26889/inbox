# A2A Protocol - Complete Implementation Plan
## Remaining Features & Timeline

This document outlines the complete plan to finish all remaining A2A protocol features: testing, documentation, DharaHIL integration, webhooks, and SSE streaming.

---

## 📊 Current Status

### ✅ **Phase 1: Foundation** (COMPLETED)
- Database schema with 9 A2A models
- AgentCard discovery endpoint
- OAuth 2.0 authentication
- Rate limiting (3-tier: client/user/IP)
- JSON-RPC 2.0 endpoint with 5 methods
- Task state machine with 7 states
- Task executor with MCP tool integration
- All 10 A2A skills mapped to MCP tools
- OAuth client management API & UI
- Background task processor (cron)
- Timeout handling & retry logic (3 attempts)
- Task approval UI & API

---

## 🎯 Phase 2: Testing (Est. 1-2 days)

### **Phase 2A: Unit Tests**

#### **2A.1: Protocol Handler Tests**
**File**: `apps/web/utils/a2a/__tests__/protocol-handler.test.ts`

```typescript
describe("A2A Protocol Handlers", () => {
  describe("handleMessageSend", () => {
    it("should create a task for valid skill")
    it("should create a message when no skill provided")
    it("should reject unknown skills")
    it("should enforce scope requirements")
    it("should mark task as auth_required for sensitive skills")
    it("should execute task immediately for non-sensitive skills")
  })

  describe("handleTaskGet", () => {
    it("should return task details with history")
    it("should reject access to other users' tasks")
    it("should return 404 for non-existent tasks")
  })

  describe("handleTaskList", () => {
    it("should filter tasks by contextId")
    it("should filter tasks by state")
    it("should limit results to 100")
    it("should order by createdAt desc")
  })

  describe("handleTaskCancel", () => {
    it("should cancel a submitted task")
    it("should cancel a working task")
    it("should reject canceling terminal state tasks")
  })

  describe("handleContextGet", () => {
    it("should return all messages in context")
    it("should verify user access to context")
    it("should limit to 1000 messages")
  })
})
```

**Dependencies**:
- Mock Prisma client
- Mock auth context
- Test fixtures for tasks/messages

---

#### **2A.2: Task Executor Tests**
**File**: `apps/web/utils/a2a/__tests__/task-executor.test.ts`

```typescript
describe("Task Executor", () => {
  describe("executeTask", () => {
    it("should execute task and transition to completed")
    it("should handle MCP tool errors")
    it("should transition to working before execution")
    it("should not execute terminal state tasks")
    it("should not execute input_required tasks")
  })

  describe("Retry Logic", () => {
    it("should retry on network errors")
    it("should retry on 503 errors")
    it("should retry on timeouts")
    it("should NOT retry on 400 errors")
    it("should NOT retry on 401 errors")
    it("should NOT retry on 404 errors")
    it("should exhaust retries after maxRetries")
    it("should increment retryCount on each retry")
    it("should update lastRetryAt timestamp")
  })

  describe("State Machine", () => {
    it("should enforce terminal state immutability")
    it("should record state transitions in history")
    it("should calculate durationMs correctly")
    it("should validate allowed state transitions")
  })

  describe("Approval Workflow", () => {
    it("should approve and execute auth_required task")
    it("should reject and terminate auth_required task")
    it("should create approval record on auth_required")
  })

  describe("isRetriableError", () => {
    it("should identify network errors as retriable")
    it("should identify 5xx errors as retriable")
    it("should identify 429 as retriable")
    it("should identify 4xx as non-retriable")
  })
})
```

---

#### **2A.3: Authentication Tests**
**File**: `apps/web/utils/a2a/__tests__/auth.test.ts`

```typescript
describe("A2A Authentication", () => {
  describe("authenticateA2aRequest", () => {
    it("should validate Bearer token")
    it("should reject missing Authorization header")
    it("should reject invalid token format")
    it("should reject expired tokens")
    it("should update client lastUsedAt")
  })

  describe("Scope Validation", () => {
    it("should validate required scope")
    it("should validate any scope")
    it("should validate all scopes")
    it("should reject insufficient scope")
  })

  describe("Email Account Ownership", () => {
    it("should verify user owns email account")
    it("should reject access to other users' accounts")
  })
})
```

---

#### **2A.4: Rate Limiting Tests**
**File**: `apps/web/utils/a2a/__tests__/rate-limit.test.ts`

```typescript
describe("A2A Rate Limiting", () => {
  describe("checkRateLimit", () => {
    it("should allow requests under limit")
    it("should block requests over limit")
    it("should reset after time window")
    it("should track per-minute limits")
    it("should track per-hour limits")
  })

  describe("Multi-tier Limits", () => {
    it("should enforce client-level limits")
    it("should enforce user-level limits")
    it("should enforce IP-level limits")
    it("should use most restrictive limit")
  })

  describe("Task Creation Limits", () => {
    it("should apply stricter limits for task creation")
  })

  describe("Cleanup", () => {
    it("should delete records older than 24 hours")
  })
})
```

---

### **Phase 2B: Integration Tests**

#### **2B.1: OAuth Flow Test**
**File**: `apps/web/__tests__/a2a-oauth-flow.test.ts`

```typescript
describe("A2A OAuth Flow", () => {
  it("should discover agent via AgentCard")
  it("should initiate OAuth authorization")
  it("should exchange code for access token")
  it("should use access token to create tasks")
  it("should refresh expired tokens")
  it("should revoke tokens")
})
```

---

#### **2B.2: Task Lifecycle Test**
**File**: `apps/web/__tests__/a2a-task-lifecycle.test.ts`

```typescript
describe("A2A Task Lifecycle", () => {
  it("should complete full task flow: submitted → working → completed")
  it("should handle failed task: submitted → working → failed")
  it("should handle retry flow: failed → submitted → working → completed")
  it("should handle approval flow: submitted → auth_required → approved → completed")
  it("should handle rejection flow: submitted → auth_required → rejected")
  it("should handle cancellation: submitted → canceled")
  it("should timeout stuck tasks: working → failed")
})
```

---

#### **2B.3: E2E Skills Test**
**File**: `apps/web/__tests__/a2a-skills-e2e.test.ts`

```typescript
describe("A2A Skills E2E", () => {
  describe("email.search", () => {
    it("should search emails and return results")
  })

  describe("email.send", () => {
    it("should send email via MCP tool")
  })

  describe("calendar.create_event", () => {
    it("should require approval")
    it("should create event after approval")
  })

  // Test all 10 skills
})
```

**Timeline**: 2 days (1 day unit tests, 1 day integration tests)

---

## 📚 Phase 3: API Documentation (Est. 1 day)

### **3.1: OpenAPI Specification**
**File**: `apps/web/public/a2a-openapi.yaml`

```yaml
openapi: 3.1.0
info:
  title: Inbox Zero A2A Protocol API
  version: 1.0.0
  description: |
    Agent-to-Agent Protocol v0.3 implementation for email and calendar automation.

    ## Authentication
    OAuth 2.0 Authorization Code flow with PKCE

    ## Rate Limits
    - Client: 60/min, 1000/hour
    - User: 100/min, 2000/hour
    - Task creation: 30/min, 500/hour

    ## AgentCard
    Discover agent capabilities at `/.well-known/agent-card.json`

servers:
  - url: https://inbox.sudiptadhara.in
    description: Production server

paths:
  /.well-known/agent-card.json:
    get:
      summary: Get AgentCard
      description: Discover agent capabilities, skills, and OAuth configuration
      responses:
        '200':
          description: AgentCard metadata
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AgentCard'

  /a2a:
    post:
      summary: A2A JSON-RPC Endpoint
      description: Execute A2A protocol methods via JSON-RPC 2.0
      security:
        - OAuth2: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/JsonRpcRequest'
            examples:
              initialize:
                summary: Initialize connection
                value:
                  jsonrpc: "2.0"
                  id: 1
                  method: "initialize"
              message.send:
                summary: Create a task
                value:
                  jsonrpc: "2.0"
                  id: 2
                  method: "message.send"
                  params:
                    contextId: "ctx_abc123"
                    skill: "email.search"
                    input:
                      query: "from:john@example.com"
                      maxResults: 10
              task.get:
                summary: Get task status
                value:
                  jsonrpc: "2.0"
                  id: 3
                  method: "task.get"
                  params:
                    taskId: "task_xyz789"
      responses:
        '200':
          description: JSON-RPC response
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/JsonRpcResponse'

  /mcp-server/authorize:
    get:
      summary: OAuth Authorization Endpoint
      description: Initiate OAuth 2.0 authorization code flow
      parameters:
        - name: client_id
          in: query
          required: true
          schema:
            type: string
        - name: redirect_uri
          in: query
          required: true
          schema:
            type: string
        - name: scope
          in: query
          required: true
          schema:
            type: string
        - name: state
          in: query
          required: true
          schema:
            type: string
        - name: code_challenge
          in: query
          required: true
          schema:
            type: string
        - name: code_challenge_method
          in: query
          required: true
          schema:
            type: string
            enum: [S256]
      responses:
        '302':
          description: Redirect to authorization page

  /mcp-server/token:
    post:
      summary: OAuth Token Endpoint
      description: Exchange authorization code for access token
      requestBody:
        required: true
        content:
          application/x-www-form-urlencoded:
            schema:
              type: object
              properties:
                grant_type:
                  type: string
                  enum: [authorization_code, refresh_token]
                code:
                  type: string
                redirect_uri:
                  type: string
                client_id:
                  type: string
                client_secret:
                  type: string
                code_verifier:
                  type: string
                refresh_token:
                  type: string
      responses:
        '200':
          description: Access token response
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/TokenResponse'

components:
  securitySchemes:
    OAuth2:
      type: oauth2
      flows:
        authorizationCode:
          authorizationUrl: /mcp-server/authorize
          tokenUrl: /mcp-server/token
          scopes:
            email:read: Read emails and search inbox
            email:write: Send emails and modify labels
            calendar:read: Read calendar events and availability
            calendar:write: Create and modify calendar events
            stats:read: Access email statistics and analytics
            rules:read: Read automation rules
            rules:write: Create and modify automation rules

  schemas:
    AgentCard:
      type: object
      properties:
        name:
          type: string
        description:
          type: string
        version:
          type: string
        url:
          type: string
        capabilities:
          type: object
        skills:
          type: array
          items:
            $ref: '#/components/schemas/Skill'
        security:
          type: object
        bindings:
          type: array

    Skill:
      type: object
      properties:
        name:
          type: string
        description:
          type: string
        inputModes:
          type: array
          items:
            type: string
        outputModes:
          type: array
          items:
            type: string
        inputSchema:
          type: object
        category:
          type: string

    JsonRpcRequest:
      type: object
      required:
        - jsonrpc
        - method
      properties:
        jsonrpc:
          type: string
          enum: ["2.0"]
        id:
          oneOf:
            - type: string
            - type: number
        method:
          type: string
          enum:
            - initialize
            - message.send
            - task.get
            - task.list
            - task.cancel
            - context.get
        params:
          type: object

    JsonRpcResponse:
      type: object
      properties:
        jsonrpc:
          type: string
          enum: ["2.0"]
        id:
          oneOf:
            - type: string
            - type: number
        result:
          type: object
        error:
          $ref: '#/components/schemas/JsonRpcError'

    JsonRpcError:
      type: object
      properties:
        code:
          type: integer
        message:
          type: string
        data:
          type: object

    TokenResponse:
      type: object
      properties:
        access_token:
          type: string
        token_type:
          type: string
          enum: [Bearer]
        expires_in:
          type: integer
        refresh_token:
          type: string
        scope:
          type: string
```

---

### **3.2: Developer Guide**
**File**: `apps/web/app/(marketing)/docs/a2a-integration-guide.md`

```markdown
# A2A Protocol Integration Guide

## Quick Start

### 1. Discover the Agent

GET /.well-known/agent-card.json

### 2. Create an OAuth Client

Visit Settings → Developer → A2A Protocol Clients

### 3. Implement OAuth Flow

[Code examples for Python, Node.js, curl]

### 4. Create Your First Task

[JSON-RPC examples]

## Skills Reference

### email.search
Search emails across all accounts

**Input**:
- `query` (string, required): Gmail-style search query
- `maxResults` (number, optional): Max results (1-50, default 10)
- `emailAccountId` (string, optional): Filter to specific account

**Output**:
- Array of email objects with subject, from, date, snippet

**Example**:
[Full example with request/response]

[Repeat for all 10 skills]

## Error Handling

### JSON-RPC Error Codes
- -32700: Parse error
- -32600: Invalid request
- -32601: Method not found
- -32602: Invalid params
- -32603: Internal error
- -32002: Authentication required
- -32003: Rate limit exceeded

### HTTP Status Codes
- 200: Success (even for JSON-RPC errors)
- 401: Unauthorized
- 429: Rate limit exceeded

## Rate Limits

[Table of limits and headers]

## Best Practices

1. Always check task state before polling
2. Implement exponential backoff for retries
3. Handle rate limits gracefully
4. Store refresh tokens securely
5. Respect Retry-After headers

## Troubleshooting

[Common issues and solutions]
```

---

### **3.3: Interactive API Explorer**
**File**: `apps/web/app/(marketing)/docs/a2a-explorer/page.tsx`

- Swagger UI for OpenAPI spec
- Live API testing with OAuth
- Request/response examples
- Rate limit visualization

**Timeline**: 1 day (OpenAPI + docs + explorer)

---

## 🔔 Phase 4: DharaHIL Integration (Est. 1 day)

### **4.1: Approval Request Sender**
**File**: `apps/web/utils/a2a/approval-notifier.ts`

```typescript
import { sendDharaHilApprovalRequest } from "@/utils/dharahil/client";

export async function sendApprovalNotification(
  taskId: string,
  userId: string,
): Promise<void> {
  const task = await prisma.a2aTask.findUnique({
    where: { id: taskId },
    include: {
      user: {
        select: {
          email: true,
          messagingChannels: {
            where: {
              isConnected: true,
              provider: { in: ["SLACK", "TELEGRAM"] },
            },
          },
        },
      },
    },
  });

  if (!task) return;

  // Get user's preferred messaging channel
  const channel = task.user.messagingChannels[0];
  if (!channel) {
    // No messaging channel connected - approval must be done in UI
    return;
  }

  // Send approval request via DharaHIL
  const dharahilResponse = await sendDharaHilApprovalRequest({
    userId,
    channel: channel.provider,
    channelId: channel.channelId,
    message: formatApprovalMessage(task),
    actions: [
      {
        label: "✅ Approve",
        action: "approve",
        style: "primary",
        callbackUrl: `${env.NEXT_PUBLIC_BASE_URL}/api/dharahil/a2a-approval-callback`,
        callbackData: {
          taskId: task.taskId,
          action: "approve",
        },
      },
      {
        label: "❌ Reject",
        action: "reject",
        style: "danger",
        callbackUrl: `${env.NEXT_PUBLIC_BASE_URL}/api/dharahil/a2a-approval-callback`,
        callbackData: {
          taskId: task.taskId,
          action: "reject",
        },
      },
    ],
  });

  // Store DharaHIL request ID for tracking
  await prisma.a2aApproval.update({
    where: { taskId: task.id },
    data: {
      dharahilRequestId: dharahilResponse.requestId,
      dharahilChannel: channel.provider,
      dharahilMessageId: dharahilResponse.messageId,
    },
  });
}

function formatApprovalMessage(task: A2aTask): string {
  return `
🤖 **A2A Task Approval Request**

**Skill**: ${task.skill}
**Client**: ${task.clientId}
**Requested**: ${task.createdAt.toLocaleString()}

**Request Data**:
\`\`\`json
${JSON.stringify(task.input, null, 2)}
\`\`\`

Please approve or reject this request.
  `.trim();
}
```

---

### **4.2: DharaHIL Callback Handler**
**File**: `apps/web/app/api/dharahil/a2a-approval-callback/route.ts`

```typescript
import { withError } from "@/utils/middleware";
import { verifyDharaHilSignature } from "@/utils/dharahil/client";
import { approveTask, rejectTask } from "@/utils/a2a/task-executor";

export const POST = withError("dharahil/a2a-approval-callback", async (request) => {
  // Verify DharaHIL signature
  const signature = request.headers.get("x-dharahil-signature");
  const body = await request.json();

  if (!verifyDharaHilSignature(body, signature)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { taskId, action, userId } = body.callbackData;

  const task = await prisma.a2aTask.findFirst({
    where: { taskId, userId },
    select: { id: true },
  });

  if (!task) {
    return Response.json({ error: "Task not found" }, { status: 404 });
  }

  if (action === "approve") {
    await approveTask(task.id, userId);
    return Response.json({ success: true, message: "Task approved" });
  } else if (action === "reject") {
    await rejectTask(task.id, userId, "Rejected via Slack/Telegram");
    return Response.json({ success: true, message: "Task rejected" });
  }

  return Response.json({ error: "Invalid action" }, { status: 400 });
});
```

---

### **4.3: Update Protocol Handler**
**File**: `apps/web/utils/a2a/protocol-handler.ts`

```typescript
// In handleMessageSend, after creating auth_required task:
if (requiresApproval) {
  await prisma.a2aApproval.create({ /* ... */ });

  // NEW: Send notification via DharaHIL
  await sendApprovalNotification(task.id, authContext.userId);
}
```

**Timeline**: 1 day (notification sender + callback handler + integration)

---

## 🔗 Phase 5: Webhook Support (Est. 1.5 days)

### **5.1: Webhook Delivery System**
**File**: `apps/web/utils/a2a/webhooks.ts`

```typescript
import { createHmac } from "crypto";

export async function sendWebhookNotification(
  taskId: string,
  event: "state_changed" | "completed" | "failed",
): Promise<void> {
  const task = await prisma.a2aTask.findUnique({
    where: { id: taskId },
    select: {
      pushNotificationUrl: true,
      pushNotificationToken: true,
      pushNotificationAuth: true,
      taskId: true,
      skill: true,
      state: true,
      stateReason: true,
      result: true,
      error: true,
    },
  });

  if (!task?.pushNotificationUrl) {
    return; // No webhook configured
  }

  const payload = {
    event,
    taskId: task.taskId,
    skill: task.skill,
    state: task.state,
    stateReason: task.stateReason,
    result: task.result,
    error: task.error,
    timestamp: new Date().toISOString(),
  };

  // Sign payload with HMAC-SHA256
  const signature = createWebhookSignature(
    payload,
    task.pushNotificationToken || "",
  );

  try {
    const response = await fetch(task.pushNotificationUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-A2A-Signature": signature,
        "X-A2A-Event": event,
        ...(task.pushNotificationAuth as Record<string, string>),
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Webhook delivery failed: ${response.status}`);
    }

    // Record successful delivery
    await prisma.a2aWebhookDelivery.create({
      data: {
        taskId: task.id,
        url: task.pushNotificationUrl,
        event,
        payload,
        statusCode: response.status,
        deliveredAt: new Date(),
      },
    });
  } catch (error: any) {
    // Record failed delivery
    await prisma.a2aWebhookDelivery.create({
      data: {
        taskId: task.id,
        url: task.pushNotificationUrl,
        event,
        payload,
        statusCode: 0,
        error: error.message,
        deliveredAt: new Date(),
      },
    });

    // Queue for retry
    await scheduleWebhookRetry(task.id, event, 1);
  }
}

function createWebhookSignature(payload: any, secret: string): string {
  return createHmac("sha256", secret)
    .update(JSON.stringify(payload))
    .digest("hex");
}
```

---

### **5.2: Webhook Retry Logic**
**File**: `apps/web/utils/a2a/webhook-retry.ts`

```typescript
const MAX_RETRIES = 3;
const RETRY_DELAYS = [60, 300, 900]; // 1min, 5min, 15min

export async function scheduleWebhookRetry(
  taskId: string,
  event: string,
  attempt: number,
): Promise<void> {
  if (attempt > MAX_RETRIES) {
    logger.error("Webhook retry exhausted", { taskId, event, attempt });
    return;
  }

  const delay = RETRY_DELAYS[attempt - 1] * 1000;

  // Use QStash or setTimeout for retry
  await enqueueBackgroundJob({
    topic: "a2a-webhook-retry",
    body: { taskId, event, attempt },
    qstash: {
      delay,
      path: "/api/a2a/webhook-retry",
    },
  });
}
```

---

### **5.3: Integrate with Task Executor**
**File**: `apps/web/utils/a2a/task-executor.ts`

```typescript
// After state transitions, send webhook:
await transitionTaskState(/* ... */);
await sendWebhookNotification(task.id, "state_changed");

// On completion:
await transitionTaskState(task.id, A2aTaskState.completed, /* ... */);
await sendWebhookNotification(task.id, "completed");

// On failure:
await transitionTaskState(task.id, A2aTaskState.failed, /* ... */);
await sendWebhookNotification(task.id, "failed");
```

**Timeline**: 1.5 days (delivery system + retry + integration)

---

## 📡 Phase 6: SSE Streaming (Est. 1.5 days)

### **6.1: SSE Endpoint**
**File**: `apps/web/app/a2a/stream/route.ts`

```typescript
import { withError } from "@/utils/middleware";
import { authenticateA2aRequest } from "@/utils/a2a/auth";

export const GET = withError("a2a/stream", async (request) => {
  const authHeader = request.headers.get("Authorization");
  const authContext = authHeader
    ? await authenticateA2aRequest(authHeader)
    : null;

  if (!authContext) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const taskId = url.searchParams.get("taskId");

  if (!taskId) {
    return new Response("Missing taskId parameter", { status: 400 });
  }

  // Verify task ownership
  const task = await prisma.a2aTask.findFirst({
    where: {
      taskId,
      userId: authContext.userId,
    },
  });

  if (!task) {
    return new Response("Task not found", { status: 404 });
  }

  // Create SSE stream
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      // Send initial state
      const sendEvent = (event: string, data: any) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      sendEvent("connected", { taskId: task.taskId });

      // Poll for task updates every 1 second
      const intervalId = setInterval(async () => {
        const updatedTask = await prisma.a2aTask.findUnique({
          where: { id: task.id },
          select: {
            state: true,
            stateReason: true,
            result: true,
            error: true,
            artifacts: true,
          },
        });

        if (!updatedTask) {
          clearInterval(intervalId);
          controller.close();
          return;
        }

        sendEvent("state", {
          state: updatedTask.state,
          stateReason: updatedTask.stateReason,
          artifacts: updatedTask.artifacts,
        });

        // Close stream on terminal states
        const terminalStates = [
          "completed",
          "failed",
          "canceled",
          "rejected",
          "unknown",
        ];
        if (terminalStates.includes(updatedTask.state)) {
          sendEvent("final", {
            state: updatedTask.state,
            result: updatedTask.result,
            error: updatedTask.error,
          });
          clearInterval(intervalId);
          controller.close();
        }
      }, 1000);

      // Clean up on connection close
      request.signal.addEventListener("abort", () => {
        clearInterval(intervalId);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
});
```

---

### **6.2: Update AgentCard**
**File**: `apps/web/app/.well-known/agent-card.json/route.ts`

```typescript
capabilities: {
  streaming: true,  // Update from false
  pushNotifications: false,
  humanInTheLoop: true,
  stateTransitionHistory: true,
},

bindings: [
  {
    url: `${env.NEXT_PUBLIC_BASE_URL}/a2a`,
    transport: "json-rpc",
    version: "0.3",
    description: "JSON-RPC 2.0 over HTTPS",
  },
  {
    url: `${env.NEXT_PUBLIC_BASE_URL}/a2a/stream`,
    transport: "sse",
    version: "0.3",
    description: "Server-Sent Events for real-time updates",
  },
],
```

---

### **6.3: Client Example**
**File**: `apps/web/app/(marketing)/docs/sse-example.md`

```typescript
// JavaScript/TypeScript client example
const eventSource = new EventSource(
  "https://inbox.sudiptadhara.in/a2a/stream?taskId=task_abc123",
  {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  },
);

eventSource.addEventListener("state", (event) => {
  const data = JSON.parse(event.data);
  console.log("Task state:", data.state, data.stateReason);
  console.log("Artifacts:", data.artifacts);
});

eventSource.addEventListener("final", (event) => {
  const data = JSON.parse(event.data);
  console.log("Task completed:", data);
  eventSource.close();
});

eventSource.addEventListener("error", (error) => {
  console.error("SSE error:", error);
  eventSource.close();
});
```

**Timeline**: 1.5 days (SSE endpoint + AgentCard update + docs + testing)

---

## 🔒 Phase 7: Security & Performance (Est. 1 day)

### **7.1: AgentCard JWS Signing**
**File**: `apps/web/utils/a2a/agentcard-signing.ts`

```typescript
import { SignJWT } from "jose";

export async function signAgentCard(agentCard: any): Promise<string> {
  const secret = new TextEncoder().encode(env.AGENTCARD_SIGNING_SECRET);

  const jws = await new SignJWT(agentCard)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(secret);

  return jws;
}

// Update AgentCard endpoint to return signed version:
export async function GET() {
  const agentCard = { /* ... */ };
  const signed = await signAgentCard(agentCard);

  return NextResponse.json(
    { agentCard, signature: signed },
    { headers: { /* ... */ } },
  );
}
```

---

### **7.2: Enhanced Audit Logging**
**File**: `apps/web/utils/a2a/audit.ts`

```typescript
export async function logA2aAuditEvent(event: {
  userId: string;
  clientId: string;
  action: string;
  taskId?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: any;
}): Promise<void> {
  await prisma.a2aAuditLog.create({
    data: {
      userId: event.userId,
      clientId: event.clientId,
      action: event.action,
      taskId: event.taskId,
      ipAddress: event.ipAddress,
      userAgent: event.userAgent,
      metadata: event.metadata,
      timestamp: new Date(),
    },
  });
}

// Add to all sensitive operations:
await logA2aAuditEvent({
  userId: authContext.userId,
  clientId: authContext.clientId,
  action: "task.create",
  taskId: task.taskId,
  metadata: { skill: task.skill },
});
```

---

### **7.3: Load Testing**
**File**: `apps/web/__tests__/load/a2a-load-test.ts`

```typescript
import { test } from "@playwright/test";
import autocannon from "autocannon";

test("A2A endpoint load test", async () => {
  const result = await autocannon({
    url: "https://inbox.sudiptadhara.in/a2a",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.TEST_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "task.list",
      params: { contextId: "ctx_test", limit: 10 },
    }),
    connections: 100,
    duration: 30,
  });

  console.log(`Requests/sec: ${result.requests.average}`);
  console.log(`Latency (avg): ${result.latency.average}ms`);
});
```

---

### **7.4: Security Audit Checklist**

- [ ] All endpoints require authentication (except AgentCard, initialize)
- [ ] Rate limits enforced on all authenticated endpoints
- [ ] OAuth tokens properly validated and revoked
- [ ] SQL injection prevention (Prisma parameterized queries)
- [ ] XSS prevention (React auto-escaping)
- [ ] CSRF protection on OAuth flow
- [ ] Webhook signature verification
- [ ] Input validation on all parameters
- [ ] No PII in logs (use logger.trace())
- [ ] Audit logging for sensitive operations
- [ ] Token refresh rotation
- [ ] Scope enforcement on all skills

**Timeline**: 1 day (signing + audit logging + load testing + security review)

---

## 📅 **Complete Timeline Summary**

| Phase | Description | Estimated Time | Priority |
|-------|-------------|---------------|----------|
| 2A | Unit Tests (handlers, executor, auth, rate-limit) | 1 day | HIGH |
| 2B | Integration Tests (OAuth, lifecycle, E2E) | 1 day | HIGH |
| 3 | API Documentation (OpenAPI + guide + explorer) | 1 day | HIGH |
| 4 | DharaHIL Integration (Slack/Telegram approvals) | 1 day | MEDIUM |
| 5 | Webhook Support (delivery + retry) | 1.5 days | MEDIUM |
| 6 | SSE Streaming (real-time updates) | 1.5 days | LOW |
| 7 | Security & Performance (signing + audit + load test) | 1 day | HIGH |

**Total Estimate**: 8 days (1.5 weeks)

---

## 🎯 **Execution Order (Recommended)**

### **Sprint 1** (Days 1-3)
1. Phase 2A: Unit tests
2. Phase 2B: Integration tests
3. Phase 3: API documentation

### **Sprint 2** (Days 4-6)
4. Phase 7: Security & performance (do early for production safety)
5. Phase 4: DharaHIL integration
6. Phase 5: Webhook support

### **Sprint 3** (Days 7-8)
7. Phase 6: SSE streaming
8. Final QA and deployment

---

## 🚀 **Next Steps**

1. Review and approve this plan
2. Set up test environment with test OAuth clients
3. Create test fixtures for integration tests
4. Begin Phase 2A: Unit tests

---

## 📊 **Success Metrics**

- **Test Coverage**: >80% code coverage on A2A modules
- **Documentation**: 100% of endpoints documented with examples
- **Performance**: <200ms avg latency, >100 req/sec throughput
- **Reliability**: <0.1% error rate on task execution
- **Security**: 0 high/critical vulnerabilities in audit

---

**Ready to begin implementation? Let's start with Phase 2A: Unit Tests!** 🎉
