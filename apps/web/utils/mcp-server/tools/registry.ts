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

  admin_categories_update: {
    name: "admin_categories_update",
    description:
      "Update a sender category's name or description. Pass only the fields you want to change. Returns NOT_FOUND if the category does not exist for this account.",
    inputSchema: {
      type: "object",
      properties: {
        categoryId: { type: "string", description: "Category ID to update" },
        name: { type: "string", description: "New name (max 30 chars)" },
        description: {
          type: "string",
          description: "New description (max 300 chars)",
        },
      },
      required: ["categoryId"],
    },
    handler: async (context, params) => {
      const { adminCategoriesUpdate } = await import(
        "./admin-categories-tools"
      );
      return adminCategoriesUpdate(context, params);
    },
    requiredScope: "admin",
  },

  admin_categories_delete: {
    name: "admin_categories_delete",
    description:
      "Delete a sender category. This tool is destructive. Call once without `confirm` to preview, then call again with `confirm: true` to apply. Senders previously in this category are detached (categoryId set to null), not deleted.",
    inputSchema: {
      type: "object",
      properties: {
        categoryId: { type: "string", description: "Category ID to delete" },
        confirm: {
          type: "boolean",
          description:
            "Set true to actually delete. Omit or false for dry-run preview.",
          default: false,
        },
      },
      required: ["categoryId"],
    },
    handler: async (context, params) => {
      const { adminCategoriesDelete } = await import(
        "./admin-categories-tools"
      );
      return adminCategoriesDelete(context, params);
    },
    requiredScope: "admin",
  },

  admin_categories_create: {
    name: "admin_categories_create",
    description:
      "Create a new sender category for this email account. Categories group senders for rule targeting and bulk archive. Name is unique per account; duplicate names return CONFLICT.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Category name (max 30 chars)" },
        description: {
          type: "string",
          description: "Optional description (max 300 chars)",
        },
      },
      required: ["name"],
    },
    handler: async (context, params) => {
      const { adminCategoriesCreate } = await import(
        "./admin-categories-tools"
      );
      return adminCategoriesCreate(context, params);
    },
    requiredScope: "admin",
  },

  admin_senders_list: {
    name: "admin_senders_list",
    description:
      "List sender addresses recorded for this email account, with their current category assignment. Supports optional categoryId filter and cursor pagination.",
    inputSchema: {
      type: "object",
      properties: {
        categoryId: {
          type: "string",
          description: "Optional: only return senders in this category",
        },
        limit: {
          type: "number",
          description: "Max results per page (1-200, default 50)",
        },
        cursor: {
          type: "string",
          description:
            "Pagination cursor (sender id from previous page's nextCursor)",
        },
      },
    },
    handler: async (context, params) => {
      const { adminSendersList } = await import("./admin-categories-tools");
      return adminSendersList(context, params);
    },
    requiredScope: "admin",
  },

  admin_senders_categorize: {
    name: "admin_senders_categorize",
    description:
      "Bulk-assign senders to categories. Commits per item, not transactionally: succeeded and failed items are reported individually. Up to 200 assignments per call.",
    inputSchema: {
      type: "object",
      properties: {
        assignments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              sender: { type: "string", description: "Sender email address" },
              categoryId: { type: "string", description: "Target category ID" },
            },
            required: ["sender", "categoryId"],
          },
          description: "List of {sender, categoryId} assignments (1-200)",
        },
      },
      required: ["assignments"],
    },
    handler: async (context, params) => {
      const { adminSendersCategorize } = await import(
        "./admin-categories-tools"
      );
      return adminSendersCategorize(context, params);
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

  admin_groups_list: {
    name: "admin_groups_list",
    description:
      "List all learned-pattern groups for the email account. Returns id, name, item count, and any rule each group is attached to.",
    inputSchema: { type: "object", properties: {} },
    handler: async (context, params) => {
      const { adminGroupsList } = await import("./admin-groups-tools");
      return adminGroupsList(context, params);
    },
    requiredScope: "admin",
  },

  admin_groups_get: {
    name: "admin_groups_get",
    description:
      "Fetch a single group with all of its items and the rule it belongs to.",
    inputSchema: {
      type: "object",
      properties: {
        groupId: { type: "string", description: "The group ID" },
      },
      required: ["groupId"],
    },
    handler: async (context, params) => {
      const { adminGroupsGet } = await import("./admin-groups-tools");
      return adminGroupsGet(context, params);
    },
    requiredScope: "admin",
  },

  admin_groups_create: {
    name: "admin_groups_create",
    description:
      "Create a learned-pattern group attached to an existing rule. Returns existing groupId if the rule already has a group.",
    inputSchema: {
      type: "object",
      properties: {
        ruleId: {
          type: "string",
          description: "The rule ID this group will be attached to.",
        },
      },
      required: ["ruleId"],
    },
    handler: async (context, params) => {
      const { adminGroupsCreate } = await import("./admin-groups-tools");
      return adminGroupsCreate(context, params);
    },
    requiredScope: "admin",
  },

  admin_groups_update: {
    name: "admin_groups_update",
    description: "Update a group's name or prompt.",
    inputSchema: {
      type: "object",
      properties: {
        groupId: { type: "string" },
        name: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["groupId"],
    },
    handler: async (context, params) => {
      const { adminGroupsUpdate } = await import("./admin-groups-tools");
      return adminGroupsUpdate(context, params);
    },
    requiredScope: "admin",
  },

  admin_groups_delete: {
    name: "admin_groups_delete",
    description:
      "Delete a group and cascade-delete all of its items. This tool is destructive. Call once without `confirm` to preview (returns item count that will cascade), then call again with `confirm: true` to apply.",
    inputSchema: {
      type: "object",
      properties: {
        groupId: { type: "string" },
        confirm: {
          type: "boolean",
          description:
            "Set true to actually delete. Omit/false to preview only.",
          default: false,
        },
      },
      required: ["groupId"],
    },
    handler: async (context, params) => {
      const { adminGroupsDelete } = await import("./admin-groups-tools");
      return adminGroupsDelete(context, params);
    },
    requiredScope: "admin",
  },

  admin_groups_add_item: {
    name: "admin_groups_add_item",
    description:
      "Add a pattern (FROM or SUBJECT) to a group. Idempotent: returns the existing item ID if the pattern is already present.",
    inputSchema: {
      type: "object",
      properties: {
        groupId: { type: "string" },
        type: { type: "string", enum: ["FROM", "SUBJECT"] },
        value: { type: "string" },
        exclude: { type: "boolean", default: false },
      },
      required: ["groupId", "type", "value"],
    },
    handler: async (context, params) => {
      const { adminGroupsAddItem } = await import("./admin-groups-tools");
      return adminGroupsAddItem(context, params);
    },
    requiredScope: "admin",
  },

  admin_groups_remove_item: {
    name: "admin_groups_remove_item",
    description: "Remove a single pattern from a group by item ID.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
      },
      required: ["itemId"],
    },
    handler: async (context, params) => {
      const { adminGroupsRemoveItem } = await import("./admin-groups-tools");
      return adminGroupsRemoveItem(context, params);
    },
    requiredScope: "admin",
  },

  admin_knowledge_list: {
    name: "admin_knowledge_list",
    description:
      "List all knowledge base items for the authorized email account, newest-updated first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Optional max number of items to return (1-200).",
        },
        cursor: {
          type: "string",
          description: "Reserved for pagination.",
        },
      },
    },
    handler: async (context, params) => {
      const { adminKnowledgeList } = await import("./admin-knowledge-tools");
      return adminKnowledgeList(context, params);
    },
    requiredScope: "admin",
  },

  admin_knowledge_get: {
    name: "admin_knowledge_get",
    description: "Get a single knowledge base item by id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The knowledge item id." },
      },
      required: ["id"],
    },
    handler: async (context, params) => {
      const { adminKnowledgeGet } = await import("./admin-knowledge-tools");
      return adminKnowledgeGet(context, params);
    },
    requiredScope: "admin",
  },

  admin_knowledge_create: {
    name: "admin_knowledge_create",
    description: "Create a new knowledge base item (title + content).",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Required, must be unique per account.",
        },
        content: { type: "string" },
      },
      required: ["title", "content"],
    },
    handler: async (context, params) => {
      const { adminKnowledgeCreate } = await import("./admin-knowledge-tools");
      return adminKnowledgeCreate(context, params);
    },
    requiredScope: "admin",
  },

  admin_knowledge_update: {
    name: "admin_knowledge_update",
    description: "Update an existing knowledge base item by id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
      },
      required: ["id", "title", "content"],
    },
    handler: async (context, params) => {
      const { adminKnowledgeUpdate } = await import("./admin-knowledge-tools");
      return adminKnowledgeUpdate(context, params);
    },
    requiredScope: "admin",
  },

  admin_knowledge_delete: {
    name: "admin_knowledge_delete",
    description:
      "Delete a knowledge base item. This tool is destructive. Call once without `confirm` to preview, then call again with `confirm: true` to apply.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        confirm: {
          type: "boolean",
          description:
            "Must be true on the second call to actually delete. Omit or set false to preview.",
          default: false,
        },
      },
      required: ["id"],
    },
    handler: async (context, params) => {
      const { adminKnowledgeDelete } = await import("./admin-knowledge-tools");
      return adminKnowledgeDelete(context, params);
    },
    requiredScope: "admin",
  },

  admin_cold_email_get_settings: {
    name: "admin_cold_email_get_settings",
    description:
      "Read cold-email blocker settings for the current account. Returns enabled flag, mode (DISABLED|LIST|LABEL|ARCHIVE_AND_LABEL|ARCHIVE_AND_READ_AND_LABEL), AI prompt, and label name.",
    inputSchema: { type: "object", properties: {} },
    handler: async (context, params) => {
      const { adminColdEmailGetSettings } = await import(
        "./admin-cold-email-tools"
      );
      return adminColdEmailGetSettings(context, params);
    },
    requiredScope: "admin",
  },

  admin_cold_email_update_settings: {
    name: "admin_cold_email_update_settings",
    description:
      "Update cold-email blocker settings. Fields: enabled (bool), mode (DISABLED|LIST|LABEL|ARCHIVE_AND_LABEL|ARCHIVE_AND_READ_AND_LABEL), prompt (string), labelName (string). Any subset may be provided; omitted fields keep existing values.",
    inputSchema: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        mode: {
          type: "string",
          enum: [
            "DISABLED",
            "LIST",
            "LABEL",
            "ARCHIVE_AND_LABEL",
            "ARCHIVE_AND_READ_AND_LABEL",
          ],
        },
        prompt: { type: ["string", "null"] },
        labelName: { type: "string" },
      },
    },
    handler: async (context, params) => {
      const { adminColdEmailUpdateSettings } = await import(
        "./admin-cold-email-tools"
      );
      return adminColdEmailUpdateSettings(context, params);
    },
    requiredScope: "admin",
  },

  admin_cold_email_list_blocked: {
    name: "admin_cold_email_list_blocked",
    description:
      "List senders currently treated as cold emails. Paginated; pass `cursor` from the previous response to fetch the next page.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          minimum: 1,
          maximum: 200,
          default: 50,
        },
        cursor: { type: "string" },
      },
    },
    handler: async (context, params) => {
      const { adminColdEmailListBlocked } = await import(
        "./admin-cold-email-tools"
      );
      return adminColdEmailListBlocked(context, params);
    },
    requiredScope: "admin",
  },

  admin_cold_email_mark: {
    name: "admin_cold_email_mark",
    description:
      "Mark a sender as cold (`action: 'mark'`) or remove a sender from the cold-email block list (`action: 'unmark'`). Not destructive — both operations are reversible by calling the tool again with the inverse action.",
    inputSchema: {
      type: "object",
      properties: {
        sender: { type: "string", description: "Email address of the sender" },
        action: { type: "string", enum: ["mark", "unmark"] },
        reason: {
          type: ["string", "null"],
          description: "Optional human-readable reason for the change",
        },
      },
      required: ["sender", "action"],
    },
    handler: async (context, params) => {
      const { adminColdEmailMark } = await import("./admin-cold-email-tools");
      return adminColdEmailMark(context, params);
    },
    requiredScope: "admin",
  },

  admin_reply_tracker_get_settings: {
    name: "admin_reply_tracker_get_settings",
    description:
      "Read Reply Zero (reply tracker) settings: whether draft replies are enabled, the draft confidence level (ALL_EMAILS | STANDARD | HIGH_CONFIDENCE), and whether hidden AI-draft tracking links are allowed.",
    inputSchema: { type: "object", properties: {} },
    handler: async (context, params) => {
      const { adminReplyTrackerGetSettings } = await import(
        "./admin-reply-tracker-tools"
      );
      return adminReplyTrackerGetSettings(context, params);
    },
    requiredScope: "admin",
  },

  admin_reply_tracker_update_settings: {
    name: "admin_reply_tracker_update_settings",
    description:
      "Update Reply Zero settings. Toggling draftRepliesEnabled creates/updates the TO_REPLY system rule and its DRAFT_EMAIL action.",
    inputSchema: {
      type: "object",
      properties: {
        draftRepliesEnabled: { type: "boolean" },
        draftReplyConfidence: {
          type: "string",
          enum: ["ALL_EMAILS", "STANDARD", "HIGH_CONFIDENCE"],
        },
        allowHiddenAiDraftLinks: { type: "boolean" },
      },
    },
    handler: async (context, params) => {
      const { adminReplyTrackerUpdateSettings } = await import(
        "./admin-reply-tracker-tools"
      );
      return adminReplyTrackerUpdateSettings(context, params);
    },
    requiredScope: "admin",
  },

  admin_follow_ups_list: {
    name: "admin_follow_ups_list",
    description:
      "List follow-up reminders (ThreadTracker rows with followUpAppliedAt set). Supports filters: resolved, type (AWAITING | NEEDS_REPLY | NEEDS_ACTION), and cursor pagination.",
    inputSchema: {
      type: "object",
      properties: {
        resolved: { type: "boolean" },
        type: {
          type: "string",
          enum: ["AWAITING", "NEEDS_REPLY", "NEEDS_ACTION"],
        },
        appliedOnly: { type: "boolean", default: true },
        limit: { type: "number", minimum: 1, maximum: 200, default: 50 },
        cursor: { type: "string" },
      },
    },
    handler: async (context, params) => {
      const { adminFollowUpsList } = await import(
        "./admin-reply-tracker-tools"
      );
      return adminFollowUpsList(context, params);
    },
    requiredScope: "admin",
  },

  admin_follow_ups_update: {
    name: "admin_follow_ups_update",
    description:
      "Update a follow-up reminder: mark resolved, reschedule via followUpAppliedAt, or clear/set followUpDraftId.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        resolved: { type: "boolean" },
        followUpAppliedAt: { type: ["string", "null"], format: "date-time" },
        followUpDraftId: { type: ["string", "null"] },
      },
      required: ["id"],
    },
    handler: async (context, params) => {
      const { adminFollowUpsUpdate } = await import(
        "./admin-reply-tracker-tools"
      );
      return adminFollowUpsUpdate(context, params);
    },
    requiredScope: "admin",
  },

  admin_digest_get: {
    name: "admin_digest_get",
    description:
      "Read the current digest configuration for the authorized email account. Returns the enabled state, schedule (intervalDays, daysOfWeek bitmask, timeOfDay, occurrences, lastOccurrenceAt, nextOccurrenceAt) and per-rule digest item membership.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async (context, params) => {
      const { adminDigestGet } = await import("./admin-digest-tools");
      return adminDigestGet(context, params);
    },
    requiredScope: "admin",
  },

  admin_digest_update_schedule: {
    name: "admin_digest_update_schedule",
    description:
      "Create or update the digest delivery schedule. At least one of intervalDays, daysOfWeek, timeOfDay, occurrences must be provided. daysOfWeek is a 7-bit bitmask (Sunday=bit 6 … Saturday=bit 0); timeOfDay is an ISO-8601 datetime where only the time portion is used.",
    inputSchema: {
      type: "object",
      properties: {
        intervalDays: {
          type: ["integer", "null"],
          minimum: 1,
          description:
            "Total interval in days between digests (e.g. 1 = daily, 7 = weekly).",
        },
        daysOfWeek: {
          type: ["integer", "null"],
          minimum: 0,
          maximum: 127,
          description:
            "Bitmask of allowed days of week (0-127). e.g. 127 = every day.",
        },
        timeOfDay: {
          type: ["string", "null"],
          format: "date-time",
          description:
            "ISO-8601 datetime; only the time portion is used (canonical date 1970-01-01).",
        },
        occurrences: {
          type: ["integer", "null"],
          minimum: 1,
          description: "Number of digests within the interval (default 1).",
        },
      },
      required: ["intervalDays", "daysOfWeek", "timeOfDay", "occurrences"],
      additionalProperties: false,
    },
    handler: async (context, params) => {
      const { adminDigestUpdateSchedule } = await import(
        "./admin-digest-tools"
      );
      return adminDigestUpdateSchedule(context, params);
    },
    requiredScope: "admin",
  },

  admin_digest_set_enabled: {
    name: "admin_digest_set_enabled",
    description:
      "Enable or disable digest delivery for the authorized email account. When enabled=false the underlying Schedule row is deleted. When enabled=true a default schedule is created (1 day interval, every day of week, 09:00) only if no schedule already exists; an existing schedule is preserved. On enable, the newsletter system rule is auto-tagged with the DIGEST action when present. Returns the post-mutation enabled boolean.",
    inputSchema: {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          description:
            "Target digest-enabled state. true = ensure schedule exists; false = delete schedule.",
        },
      },
      required: ["enabled"],
      additionalProperties: false,
    },
    handler: async (context, params) => {
      const { adminDigestSetEnabled } = await import("./admin-digest-tools");
      return adminDigestSetEnabled(context, params);
    },
    requiredScope: "admin",
  },

  admin_digest_update_items: {
    name: "admin_digest_update_items",
    description:
      "Set which rules contribute to the digest. Pass a map of rule ID to boolean (true = include in digest, false = exclude). Rules not present in the map are left unchanged. Returns a per-item result: { succeeded, failed, total, successCount, failureCount }.",
    inputSchema: {
      type: "object",
      properties: {
        ruleDigestPreferences: {
          type: "object",
          additionalProperties: { type: "boolean" },
          description: "Map of rule ID to digest-enabled boolean.",
        },
      },
      required: ["ruleDigestPreferences"],
      additionalProperties: false,
    },
    handler: async (context, params) => {
      const { adminDigestUpdateItems } = await import("./admin-digest-tools");
      return adminDigestUpdateItems(context, params);
    },
    requiredScope: "admin",
  },

  admin_follow_ups_delete: {
    name: "admin_follow_ups_delete",
    description:
      "This tool is destructive. Call once without confirm to preview, then call again with confirm: true to apply. Deletes a single follow-up reminder row from ThreadTracker. Provide expectedUpdatedAt (the updatedAt returned by the preview) to detect mid-flight changes.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        expectedUpdatedAt: { type: "string", format: "date-time" },
        confirm: { type: "boolean", default: false },
      },
      required: ["id"],
    },
    handler: async (context, params) => {
      const { adminFollowUpsDelete } = await import(
        "./admin-reply-tracker-tools"
      );
      return adminFollowUpsDelete(context, params);
    },
    requiredScope: "admin",
  },

  admin_ai_get_settings: {
    name: "admin_ai_get_settings",
    description:
      "Read the current AI provider and model for the inbox account, plus the list of allowed providers. API keys are NEVER returned by this tool.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async (context, params) => {
      const { adminAiGetSettings } = await import("./admin-ai-tools");
      return adminAiGetSettings(context, params);
    },
    requiredScope: "admin",
  },

  admin_ai_update_model: {
    name: "admin_ai_update_model",
    description:
      "Update the AI provider and/or model name for the inbox account. This tool does NOT accept API keys, secrets, or tokens — those must be configured through the web UI. Pass aiProvider='DEFAULT' to revert to the system default model (the stored API key, if any, is preserved).",
    inputSchema: {
      type: "object",
      properties: {
        aiProvider: {
          type: "string",
          description:
            "One of the allowed provider IDs returned by admin_ai_get_settings (e.g. 'anthropic', 'openai', 'litellm', or 'DEFAULT').",
        },
        aiModel: {
          type: "string",
          description:
            "Model name, e.g. 'claude-4.7-sonnet' or 'gpt-5.1'. Use '' when aiProvider is 'DEFAULT'.",
        },
      },
      required: ["aiProvider", "aiModel"],
      additionalProperties: false,
    },
    handler: async (context, params) => {
      const { adminAiUpdateModel } = await import("./admin-ai-tools");
      return adminAiUpdateModel(context, params);
    },
    requiredScope: "admin",
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
