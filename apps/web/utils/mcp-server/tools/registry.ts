import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * MCP Tool Registry
 *
 * Defines all available tools that can be called via the MCP protocol.
 * Each tool has a name, description, input schema, and handler function.
 */

export interface McpToolContext {
  userId: string;
  emailAccountId: string;
  clientId: string;
  scopes: string[];
}

export interface McpToolHandler {
  (context: McpToolContext, params: any): Promise<any>;
}

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
    description: "Search through emails using query text. Returns a list of matching emails with subject, sender, date, and snippet.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'from:john@example.com subject:invoice')",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of results to return (default: 10, max: 50)",
          default: 10,
        },
      },
      required: ["query"],
    },
    handler: async (context, params) => {
      // Import dynamically to avoid circular dependencies
      const { searchEmails } = await import("./email-tools");
      return searchEmails(context, params);
    },
    requiredScope: "email:read",
  },

  get_email: {
    name: "get_email",
    description: "Get full details of a specific email by ID, including body content, attachments, and metadata.",
    inputSchema: {
      type: "object",
      properties: {
        emailId: {
          type: "string",
          description: "The email ID or thread ID",
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
    description: "Send a new email. Supports plain text and HTML content.",
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

  get_calendar_availability: {
    name: "get_calendar_availability",
    description: "Check calendar availability for a specific date range. Returns busy/free status.",
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

  create_rule: {
    name: "create_rule",
    description: "Create a new email automation rule.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Rule name",
        },
        conditions: {
          type: "object",
          description: "Rule conditions (from, subject, etc.)",
        },
        actions: {
          type: "array",
          description: "Actions to perform (archive, label, etc.)",
        },
      },
      required: ["name", "conditions", "actions"],
    },
    handler: async (context, params) => {
      const { createRule } = await import("./rules-tools");
      return createRule(context, params);
    },
    requiredScope: "rules:write",
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
  return Object.values(MCP_TOOLS).map(({ handler, requiredScope, ...tool }) => tool);
}

/**
 * Check if user has required scope for tool
 */
export function hasRequiredScope(tool: McpToolDefinition, userScopes: string[]): boolean {
  return userScopes.includes(tool.requiredScope);
}
