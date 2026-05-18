import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpResult } from "../envelope";

/**
 * MCP Tool Registry
 *
 * Defines all available tools that can be called via the MCP protocol.
 * Each tool has a name, description, input schema, and handler function.
 */

export interface McpToolContext {
  clientId: string;
  emailAccountId: string;
  scopes: string[];
  userId: string;
}

// Union return type: new admin tools must return an `McpResult<unknown>`
// envelope (ok/error discriminant); pre-envelope tools (search_emails,
// get_email, send_email, calendar, stats) still return plain objects.
// New tools should target `McpResult<unknown>`.
export type McpToolHandler = (
  context: McpToolContext,
  params: unknown,
) => Promise<McpResult<unknown> | unknown>;

export interface McpToolDefinition extends Tool {
  handler: McpToolHandler;
  requiredScope: string;
}

/**
 * All available MCP tools
 */
export const MCP_TOOLS: Record<string, McpToolDefinition> = {
  search_emails: {
    name: "search_emails",
    description:
      "Search through emails across all your connected email accounts, or filter to a specific account. Returns a list of matching emails with subject, sender, date, snippet, and which account each email belongs to.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search query (e.g., 'from:john@example.com subject:invoice')",
        },
        maxResults: {
          type: "number",
          description:
            "Maximum number of results to return per account (default: 10, max: 50)",
          default: 10,
        },
        emailAccountId: {
          type: "string",
          description:
            "Optional: Filter results to a specific email account ID. Use list_email_accounts to get available account IDs and emails. If not provided, searches across all your linked email accounts. If the account ID is invalid or not linked to your user, an error message will be returned.",
        },
      },
      required: ["query"],
    },
    handler: async (context, params) => {
      // Import dynamically to avoid circular dependencies
      const { searchEmailsMultiAccount } = await import("./email-tools");
      return searchEmailsMultiAccount(context, params);
    },
    requiredScope: "email:read",
  },

  get_email: {
    name: "get_email",
    description:
      "Get full details of a specific email by ID or Gmail URL, including body content, attachments, and metadata. Supports direct Gmail URLs (e.g., https://mail.google.com/mail/u/0/?ik=...&view=pt&search=all&permthid=thread-f:...) and raw email IDs. IMPORTANT: Email IDs are account-specific. If you get an error fetching an email, the email might belong to a different email account. Use list_email_accounts to see all accounts, then specify the correct emailAccountId parameter.",
    inputSchema: {
      type: "object",
      properties: {
        emailId: {
          type: "string",
          description:
            "The email ID, thread ID, or full Gmail URL (e.g., https://mail.google.com/mail/u/0/?ik=54c0f4487e&view=pt&search=all&permthid=thread-f:1857728267523417974)",
        },
        emailAccountId: {
          type: "string",
          description:
            "Optional: Email account ID to fetch from. Use list_email_accounts to get available account IDs. If not provided, uses the default authorized account. If you searched emails and got results from multiple accounts, use the accountId from the search result.",
        },
      },
      required: ["emailId"],
    },
    handler: async (context, params) => {
      const { getEmail } = await import("./email-tools");
      return getEmail(context, params);
    },
    requiredScope: "email:read",
  },

  send_email: {
    name: "send_email",
    description:
      "Send a new email from one of your configured email accounts. Supports plain text and HTML content. IMPORTANT: You must use the exact email address from one of your linked accounts (check with list_email_accounts tool). The 'from' parameter must match exactly.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "array",
          items: { type: "string" },
          description: "Recipient email addresses",
        },
        subject: {
          type: "string",
          description: "Email subject",
        },
        body: {
          type: "string",
          description: "Email body (plain text or HTML)",
        },
        from: {
          type: "string",
          description:
            "Sender email address (REQUIRED when you have multiple accounts). MUST be one of your configured account emails. Use list_email_accounts tool to see available emails. Example: 'admin@sudiptadhara.in' or 'sudiptai26.889@gmail.com'. If the email doesn't match any configured account, the send will fail.",
        },
        cc: {
          type: "array",
          items: { type: "string" },
          description: "CC recipients (optional)",
        },
        bcc: {
          type: "array",
          items: { type: "string" },
          description: "BCC recipients (optional)",
        },
      },
      required: ["to", "subject", "body"],
    },
    handler: async (context, params) => {
      const { sendEmail } = await import("./email-tools");
      return sendEmail(context, params);
    },
    requiredScope: "email:write",
  },

  search_calendar: {
    name: "search_calendar",
    description: "Search calendar events by date range or query text.",
    inputSchema: {
      type: "object",
      properties: {
        startDate: {
          type: "string",
          description: "Start date (ISO 8601 format)",
        },
        endDate: {
          type: "string",
          description: "End date (ISO 8601 format)",
        },
        query: {
          type: "string",
          description: "Optional search query for event title/description",
        },
      },
      required: ["startDate", "endDate"],
    },
    handler: async (context, params) => {
      const { searchCalendar } = await import("./calendar-tools");
      return searchCalendar(context, params);
    },
    requiredScope: "calendar:read",
  },

  get_calendar_event: {
    name: "get_calendar_event",
    description:
      "Get full details of a specific calendar event by ID or Google Calendar URL. Supports direct Google Calendar URLs (e.g., https://calendar.google.com/calendar/event?eid=...) and raw event IDs.",
    inputSchema: {
      type: "object",
      properties: {
        eventId: {
          type: "string",
          description:
            "The event ID or full Google Calendar URL (e.g., https://calendar.google.com/calendar/event?eid=ABC123xyz)",
        },
      },
      required: ["eventId"],
    },
    handler: async (context, params) => {
      const { getCalendarEvent } = await import("./calendar-tools");
      return getCalendarEvent(context, params);
    },
    requiredScope: "calendar:read",
  },

  get_calendar_availability: {
    name: "get_calendar_availability",
    description:
      "Check calendar availability for a specific date range. Returns busy/free status.",
    inputSchema: {
      type: "object",
      properties: {
        startDate: {
          type: "string",
          description: "Start date/time (ISO 8601 format)",
        },
        endDate: {
          type: "string",
          description: "End date/time (ISO 8601 format)",
        },
      },
      required: ["startDate", "endDate"],
    },
    handler: async (context, params) => {
      const { getCalendarAvailability } = await import("./calendar-tools");
      return getCalendarAvailability(context, params);
    },
    requiredScope: "calendar:read",
  },

  create_calendar_event: {
    name: "create_calendar_event",
    description:
      "Create a new calendar event with attendees on sudiptai26.889@gmail.com (Sudipta's personal Google Calendar). REQUIRES HUMAN APPROVAL via WhatsApp/Telegram before the event is created.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Event title/summary",
        },
        startTime: {
          type: "string",
          description:
            "Start date/time (ISO 8601 format, e.g., '2026-03-20T14:00:00Z')",
        },
        endTime: {
          type: "string",
          description:
            "End date/time (ISO 8601 format, e.g., '2026-03-20T15:00:00Z')",
        },
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "List of attendee email addresses",
        },
        description: {
          type: "string",
          description: "Event description/notes (optional)",
        },
        location: {
          type: "string",
          description:
            "Event location (optional, e.g., 'Zoom', 'Conference Room A')",
        },
        sendInvite: {
          type: "boolean",
          description:
            "Whether to send calendar invites to attendees (default: true)",
        },
      },
      required: ["title", "startTime", "endTime"],
    },
    handler: async (context, params) => {
      const { createCalendarEvent } = await import("./calendar-tools");
      return createCalendarEvent(context, params);
    },
    requiredScope: "calendar:write",
  },

  get_email_stats: {
    name: "get_email_stats",
    description: "Get email statistics and analytics for a time period.",
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
    handler: async (context, params) => {
      const { getEmailStats } = await import("./stats-tools");
      return getEmailStats(context, params);
    },
    requiredScope: "stats:read",
  },

  list_rules: {
    name: "list_rules",
    description: "List all automation rules configured for the email account.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async (context, params) => {
      const { listRules } = await import("./rules-tools");
      return listRules(context, params);
    },
    requiredScope: "rules:read",
  },

  admin_rules_list: {
    name: "admin_rules_list",
    description:
      "List all automation rules for the email account, including each rule's actions, enabled state, and display order. Read-only.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async (context, params) => {
      const { adminRulesList } = await import("./admin-rules-tools");
      return adminRulesList(context, params);
    },
    requiredScope: "admin",
  },

  admin_rules_get: {
    name: "admin_rules_get",
    description:
      "Get full details of a single automation rule by ID, including its actions and group condition.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The rule ID returned by admin_rules_list.",
        },
      },
      required: ["id"],
    },
    handler: async (context, params) => {
      const { adminRulesGet } = await import("./admin-rules-tools");
      return adminRulesGet(context, params);
    },
    requiredScope: "admin",
  },

  admin_rules_create: {
    name: "admin_rules_create",
    description:
      "Create a new automation rule for the email account. Validated with the same Zod schema as the web UI. Returns the created rule and its actions.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name of the rule" },
        runOnThreads: {
          type: "boolean",
          description: "Whether the rule runs on threads (default true)",
        },
        actions: {
          type: "array",
          description:
            "Actions to execute when the rule matches (see Zod schema for shape)",
        },
        conditions: {
          type: "array",
          description:
            "Conditions that trigger the rule (AI or STATIC entries; see Zod schema)",
        },
        conditionalOperator: {
          type: "string",
          enum: ["AND", "OR"],
          description: "How to combine multiple conditions",
        },
      },
      required: ["name", "actions", "conditions"],
    },
    handler: async (context, params) => {
      const { adminRulesCreate } = await import("./admin-rules-tools");
      return adminRulesCreate(context, params);
    },
    requiredScope: "admin",
  },

  admin_rules_update: {
    name: "admin_rules_update",
    description:
      "Update an existing automation rule. Replaces actions and conditions atomically.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Rule ID" },
        name: { type: "string" },
        runOnThreads: { type: "boolean" },
        actions: { type: "array" },
        conditions: { type: "array" },
        conditionalOperator: { type: "string", enum: ["AND", "OR"] },
      },
      required: ["id", "name", "actions", "conditions"],
    },
    handler: async (context, params) => {
      const { adminRulesUpdate } = await import("./admin-rules-tools");
      return adminRulesUpdate(context, params);
    },
    requiredScope: "admin",
  },

  admin_rules_delete: {
    name: "admin_rules_delete",
    description:
      "Delete an automation rule. This tool is destructive. Call once without `confirm` to preview what will be deleted, then call again with `confirm: true` to actually delete.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Rule ID to delete" },
        confirm: {
          type: "boolean",
          description:
            "Set to true to actually delete. Omit or set false to get a dry-run preview.",
        },
      },
      required: ["id"],
    },
    handler: async (context, params) => {
      const { adminRulesDelete } = await import("./admin-rules-tools");
      return adminRulesDelete(context, params);
    },
    requiredScope: "admin",
  },

  admin_rules_set_enabled: {
    name: "admin_rules_set_enabled",
    description:
      "Enable or disable a specific automation rule by ruleId. Non-destructive.",
    inputSchema: {
      type: "object",
      properties: {
        ruleId: { type: "string", description: "Rule ID to toggle" },
        enabled: { type: "boolean", description: "Target enabled state" },
      },
      required: ["ruleId", "enabled"],
    },
    handler: async (context, params) => {
      const { adminRulesSetEnabled } = await import("./admin-rules-tools");
      return adminRulesSetEnabled(context, params);
    },
    requiredScope: "admin",
  },

  admin_rules_reorder: {
    name: "admin_rules_reorder",
    description:
      "Set the display order of automation rules. The ruleIds array must contain exactly the set of rules owned by the account; the new displayOrder is assigned in the order supplied (0 = first).",
    inputSchema: {
      type: "object",
      properties: {
        ruleIds: {
          type: "array",
          items: { type: "string" },
          description: "Rule IDs in their new order",
        },
      },
      required: ["ruleIds"],
    },
    handler: async (context, params) => {
      const { adminRulesReorder } = await import("./admin-rules-tools");
      return adminRulesReorder(context, params);
    },
    requiredScope: "admin",
  },

  admin_categories_list: {
    name: "admin_categories_list",
    description:
      "List all sender categories for this email account. Returns id, name, description, createdAt, updatedAt for each. Read-only.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async (context, params) => {
      const { adminCategoriesList } = await import("./admin-categories-tools");
      return adminCategoriesList(context, params);
    },
    requiredScope: "admin",
  },

  list_email_accounts: {
    name: "list_email_accounts",
    description:
      "List all email accounts you have configured. Use this to see which email addresses you can send from.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async (context, params) => {
      const { listEmailAccounts } = await import("./email-tools");
      return listEmailAccounts(context, params);
    },
    requiredScope: "email:read",
  },
};

/**
 * Get tool by name
 */
export function getTool(name: string): McpToolDefinition | undefined {
  return MCP_TOOLS[name];
}

/**
 * Get all tool definitions (without handlers)
 */
export function getAllTools(): Tool[] {
  return Object.values(MCP_TOOLS).map(
    ({ handler, requiredScope, ...tool }) => tool,
  );
}

/**
 * Check if user has required scope for tool
 */
export function hasRequiredScope(
  tool: McpToolDefinition,
  userScopes: string[],
): boolean {
  return userScopes.includes(tool.requiredScope);
}
