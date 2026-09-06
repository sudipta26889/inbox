import { NextResponse } from "next/server";
import { env } from "@/env";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("agent-card");

/**
 * AgentCard following A2A Protocol v0.3 specification
 *
 * This exposes the capabilities of the Inbox agent to external agents
 * Best Practices Implemented:
 * - Comprehensive skill definitions with input schemas
 * - Multiple skill categories for discoverability
 * - OAuth 2.0 security with granular scopes
 * - Clear capability declarations
 * - JWS signature support (optional, future)
 * - Proper caching headers
 */
const AGENT_CARD = {
  // ============ Basic Information ============
  name: "Inbox Email Automation Agent",
  description:
    "AI-powered email and calendar automation with multi-account support, " +
    "human-in-the-loop approvals, and advanced AI features for categorization, " +
    "summarization, and composition. Supports Gmail, Google Workspace, and Outlook. " +
    "Can send outbound A2A notifications to remote agents when automation rules match urgent emails.",
  version: "1.0.0",
  url: env.NEXT_PUBLIC_BASE_URL,

  // ============ Provider Information ============
  provider: {
    name: "Inbox",
    url: env.NEXT_PUBLIC_BASE_URL,
    supportUrl: `${env.NEXT_PUBLIC_BASE_URL}/help`,
  },

  // ============ Capabilities ============
  capabilities: {
    streaming: true, // SSE at /a2a/stream
    pushNotifications: true, // Webhooks, configured per client
    humanInTheLoop: true, // Supports approval workflows
    stateTransitionHistory: true, // Tracks task state changes
  },

  // ============ Skills (Initial set - will expand) ============
  skills: [
    // -------- EMAIL MANAGEMENT SKILLS --------
    {
      name: "email.search",
      description:
        "Search emails across all connected accounts with Gmail-style query syntax. " +
        "Supports advanced filters: from:, to:, subject:, label:, has:attachment, is:unread, etc.",
      inputModes: ["text", "structured_data"],
      outputModes: ["structured_data"],
      category: "email_management",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Gmail-style search query (e.g., 'from:boss@company.com label:urgent')",
          },
          maxResults: {
            type: "number",
            description: "Maximum number of results to return",
            default: 10,
            minimum: 1,
            maximum: 50,
          },
          emailAccountId: {
            type: "string",
            description:
              "Optional: Filter to specific email account. Use account.list skill to get IDs.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "email.get",
      description:
        "Get full email details including body, attachments, headers, and metadata. " +
        "Supports Gmail URLs and raw email IDs.",
      inputModes: ["text"],
      outputModes: ["text", "structured_data"],
      category: "email_management",
      inputSchema: {
        type: "object",
        properties: {
          emailId: {
            type: "string",
            description: "Email ID or full Gmail URL",
          },
          emailAccountId: {
            type: "string",
            description: "Optional: specific email account ID",
          },
        },
        required: ["emailId"],
      },
    },
    {
      name: "email.send",
      description:
        "Send email from configured accounts. Supports HTML, CC, BCC, and multiple recipients.",
      inputModes: ["structured_data"],
      outputModes: ["structured_data"],
      category: "email_management",
      inputSchema: {
        type: "object",
        properties: {
          from: {
            type: "string",
            format: "email",
            description: "Sender email address (must be a configured account)",
          },
          to: {
            type: "array",
            items: { type: "string", format: "email" },
            description: "Recipient email addresses",
          },
          subject: {
            type: "string",
            description: "Email subject line",
          },
          body: {
            type: "string",
            description: "Email body (supports HTML)",
          },
          cc: {
            type: "array",
            items: { type: "string", format: "email" },
            description: "CC recipients",
          },
          bcc: {
            type: "array",
            items: { type: "string", format: "email" },
            description: "BCC recipients",
          },
        },
        required: ["from", "to", "subject", "body"],
      },
    },
    // -------- CALENDAR MANAGEMENT SKILLS --------
    {
      name: "calendar.search",
      description:
        "Search calendar events by date range and query text. Supports filtering by attendees and location.",
      inputModes: ["structured_data"],
      outputModes: ["structured_data"],
      category: "calendar_management",
      inputSchema: {
        type: "object",
        properties: {
          startDate: {
            type: "string",
            format: "date-time",
            description: "Search from this date",
          },
          endDate: {
            type: "string",
            format: "date-time",
            description: "Search until this date",
          },
          query: {
            type: "string",
            description: "Search query for event title/description",
          },
        },
        required: ["startDate", "endDate"],
      },
    },
    {
      name: "calendar.get_event",
      description:
        "Get full calendar event details including attendees, location, and notes.",
      inputModes: ["text"],
      outputModes: ["structured_data"],
      category: "calendar_management",
      inputSchema: {
        type: "object",
        properties: {
          eventId: {
            type: "string",
            description: "Event ID or Google Calendar URL",
          },
        },
        required: ["eventId"],
      },
    },
    {
      name: "calendar.availability",
      description:
        "Check calendar availability (busy/free) for scheduling. Returns time slots and conflict information.",
      inputModes: ["structured_data"],
      outputModes: ["structured_data"],
      category: "calendar_management",
      inputSchema: {
        type: "object",
        properties: {
          startDate: {
            type: "string",
            format: "date-time",
          },
          endDate: {
            type: "string",
            format: "date-time",
          },
        },
        required: ["startDate", "endDate"],
      },
    },
    {
      name: "calendar.create_event",
      description:
        "Create calendar event with attendees. " +
        "REQUIRES HUMAN APPROVAL via messaging channel before creation. " +
        "Task will enter 'auth_required' state pending approval.",
      inputModes: ["structured_data"],
      outputModes: ["structured_data"],
      category: "calendar_management",
      requiresHumanApproval: true,
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Event title",
          },
          startTime: {
            type: "string",
            format: "date-time",
            description: "Event start time (ISO 8601)",
          },
          endTime: {
            type: "string",
            format: "date-time",
            description: "Event end time (ISO 8601)",
          },
          attendees: {
            type: "array",
            items: { type: "string", format: "email" },
            description: "Attendee email addresses",
          },
          description: {
            type: "string",
            description: "Event description/notes",
          },
          location: {
            type: "string",
            description: "Event location or meeting link",
          },
        },
        required: ["title", "startTime", "endTime"],
      },
    },
    // -------- AUTOMATION SKILLS --------
    {
      name: "automation.list_rules",
      description:
        "List all configured email automation rules with conditions and actions.",
      inputModes: [],
      outputModes: ["structured_data"],
      category: "automation",
    },
    // -------- DIGEST SKILLS --------
    {
      name: "digest.get",
      description:
        "Get the stored cross-account morning digest: what is urgent, what is waiting on a reply, and what has gone quiet, per connected email account. Generated once each morning and kept for two days. Also pushed unprompted to agents on this instance's outbound allowlist.",
      inputModes: ["structured_data"],
      outputModes: ["structured_data"],
      category: "email_management",
      inputSchema: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description:
              "Digest date as YYYY-MM-DD in the account's timezone. Defaults to today.",
          },
        },
      },
    },
    // -------- ANALYTICS SKILLS --------
    {
      name: "stats.email_analytics",
      description:
        "Get email statistics and analytics for time periods. Includes volume trends, response times, and top senders.",
      inputModes: ["structured_data"],
      outputModes: ["structured_data"],
      category: "analytics",
      inputSchema: {
        type: "object",
        properties: {
          period: {
            type: "string",
            enum: ["day", "week", "month", "year"],
            description: "Time period for statistics",
          },
        },
        required: ["period"],
      },
    },
    // -------- ACCOUNT MANAGEMENT SKILLS --------
    {
      name: "account.list",
      description:
        "List all connected email accounts with provider information and sync status.",
      inputModes: [],
      outputModes: ["structured_data"],
      category: "account_management",
    },
  ],

  // ============ Security Configuration ============
  security: {
    type: "oauth2",
    flows: {
      authorizationCode: {
        authorizationUrl: `${env.NEXT_PUBLIC_BASE_URL}/mcp-server/authorize`,
        tokenUrl: `${env.NEXT_PUBLIC_BASE_URL}/mcp-server/token`,
        scopes: {
          "email:read": "Read emails and search inbox",
          "email:write": "Send emails and modify labels",
          "calendar:read": "Read calendar events and availability",
          "calendar:write": "Create and modify calendar events",
          "stats:read": "Access email statistics and analytics",
          "rules:read": "Read automation rules",
          "rules:write": "Create and modify automation rules",
          "ai:analyze": "Use AI analysis features (Phase 4)",
        },
      },
    },
  },

  // ============ Protocol Bindings ============
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
      description: "Server-sent task state updates",
    },
  ],

  // ============ Metadata ============
  metadata: {
    tags: ["email", "calendar", "automation", "ai", "productivity"],
    categories: ["communication", "productivity", "ai-assistant"],
    supportedProviders: ["Gmail", "Google Workspace", "Outlook"],
    features: [
      "Multi-account email management",
      "Calendar integration with scheduling",
      "Rule-based automation",
      "Human-in-the-loop approvals",
      "Email analytics and insights",
    ],
    limits: {
      maxTasksPerContext: 100,
      maxConcurrentTasks: 10,
      taskTimeout: 300, // 5 minutes
    },
  },
};

/**
 * GET /.well-known/agent-card.json
 *
 * Returns the AgentCard with optional JWS signature
 * Implements proper caching per A2A best practices
 */
export async function GET() {
  try {
    logger.info("AgentCard requested");

    // TODO Phase 5: Add JWS signature support
    // if (env.A2A_ENABLE_SIGNING === "true" && env.A2A_SIGNING_PRIVATE_KEY) {
    //   const { signAgentCard } = await import("@/utils/a2a/signing");
    //   const signature = await signAgentCard(AGENT_CARD);
    //   responseCard = {
    //     ...AGENT_CARD,
    //     signatures: [{ signature, keyId: env.A2A_SIGNING_KEY_ID, algorithm: "RS256" }],
    //   };
    // }

    return NextResponse.json(AGENT_CARD, {
      headers: {
        "Content-Type": "application/json",
        // Cache for 1 hour (agents should refetch periodically)
        "Cache-Control": "public, max-age=3600, must-revalidate",
        // Add CORS headers for cross-origin access
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  } catch (error) {
    logger.error("Failed to generate AgentCard", { error });

    // Return card without signature as fallback
    return NextResponse.json(AGENT_CARD, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300", // Shorter cache on error
      },
    });
  }
}

/**
 * OPTIONS /.well-known/agent-card.json
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
