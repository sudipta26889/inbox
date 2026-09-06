/**
 * Maps A2A skills to the MCP tool that implements them.
 *
 * Kept free of runtime imports so it can be verified in isolation — a skill
 * pointing at a tool that does not exist otherwise fails only on a live call.
 */
export interface A2aSkillDefinition {
  mcpTool: string; // Corresponding MCP tool (e.g., "search_emails")
  requiredScope: string; // OAuth scope required
  requiresApproval?: boolean; // Does this skill require human approval?
  skill: string; // A2A skill name (e.g., "email.search")
}

/**
 * Skill registry - maps A2A skills to MCP tools
 * This will be expanded as we add more skills
 */
export const A2A_SKILL_REGISTRY: Record<string, A2aSkillDefinition> = {
  "email.search": {
    skill: "email.search",
    mcpTool: "search_emails",
    requiredScope: "email:read",
  },
  "email.get": {
    skill: "email.get",
    mcpTool: "get_email",
    requiredScope: "email:read",
  },
  "email.send": {
    skill: "email.send",
    mcpTool: "send_email",
    requiredScope: "email:write",
  },
  "calendar.search": {
    skill: "calendar.search",
    mcpTool: "search_calendar",
    requiredScope: "calendar:read",
  },
  "calendar.get_event": {
    skill: "calendar.get_event",
    mcpTool: "get_calendar_event",
    requiredScope: "calendar:read",
  },
  "calendar.availability": {
    skill: "calendar.availability",
    mcpTool: "get_calendar_availability",
    requiredScope: "calendar:read",
  },
  "calendar.create_event": {
    skill: "calendar.create_event",
    mcpTool: "create_calendar_event",
    requiredScope: "calendar:write",
    requiresApproval: true,
  },
  "digest.get": {
    skill: "digest.get",
    mcpTool: "get_daily_digest",
    requiredScope: "email:read",
  },
  "automation.list_rules": {
    skill: "automation.list_rules",
    mcpTool: "list_rules",
    requiredScope: "rules:read",
  },
  "stats.email_analytics": {
    skill: "stats.email_analytics",
    mcpTool: "get_email_stats",
    requiredScope: "stats:read",
  },
  "account.list": {
    skill: "account.list",
    mcpTool: "list_email_accounts",
    requiredScope: "email:read",
  },
};
