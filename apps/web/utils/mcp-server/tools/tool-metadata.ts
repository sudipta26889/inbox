/**
 * Human title and the four MCP behaviour hints for every tool, kept in one place
 * so the rules are reviewable together. Clients decide what to ask a person to
 * approve from these hints, so a wrong value is a security bug, not cosmetics.
 *
 * Rules:
 * - Read tools (scope ends in `:read`): read-only, not destructive, idempotent.
 * - Destructive: sending, deleting, and the two admin tools that start a bulk
 *   job (cleanup, unsubscribe). Nothing else.
 * - Open world: the effect reaches another person or an outside service. Drafts
 *   do not; they only write to the user's own mailbox.
 * - Idempotent writes are set/update calls where repeating changes nothing more.
 *   When unsure, false.
 */

type ToolMetadata = {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

export const TOOL_METADATA: Record<string, ToolMetadata> = {
  // Email
  search_emails: read("Search emails"),
  get_email: read("Get email"),
  get_attachment: read("Get attachment"),
  list_email_accounts: read("List email accounts"),
  send_email: write("Send email", {
    destructive: true,
    openWorld: true,
  }),
  create_draft: write("Create draft"),
  update_draft: write("Update draft", { idempotent: true }),
  list_drafts: read("List drafts"),
  get_draft: read("Get draft"),
  delete_draft: write("Delete draft", { destructive: true, idempotent: true }),

  // Calendar
  search_calendar: read("Search calendar"),
  get_calendar_event: read("Get calendar event"),
  get_calendar_availability: read("Get calendar availability"),
  list_calendars: read("List calendars"),
  list_calendar_event_instances: read("List calendar event instances"),
  create_calendar_event: write("Create calendar event", { openWorld: true }),
  update_calendar_event: write("Update calendar event", {
    idempotent: true,
    openWorld: true,
  }),
  delete_calendar_event: write("Delete calendar event", {
    destructive: true,
    openWorld: true,
  }),
  respond_to_calendar_event: write("Respond to calendar event", {
    idempotent: true,
    openWorld: true,
  }),

  // Stats, rules and tasks
  get_email_stats: read("Get email stats"),
  list_rules: read("List rules"),

  // Admin: rules
  admin_rules_list: read("List rules (admin)"),
  admin_rules_get: read("Get rule (admin)"),
  admin_rules_create: write("Create rule"),
  admin_rules_update: write("Update rule", { idempotent: true }),
  admin_rules_delete: write("Delete rule", { destructive: true }),
  admin_rules_set_enabled: write("Enable or disable rule", {
    idempotent: true,
  }),
  admin_rules_reorder: write("Reorder rules", { idempotent: true }),

  // Admin: categories and senders
  admin_categories_list: read("List categories"),
  admin_categories_create: write("Create category"),
  admin_categories_update: write("Update category", { idempotent: true }),
  admin_categories_delete: write("Delete category", { destructive: true }),
  admin_senders_list: read("List senders"),
  admin_senders_categorize: write("Categorize sender", { idempotent: true }),

  // Admin: groups
  admin_groups_list: read("List groups"),
  admin_groups_get: read("Get group"),
  admin_groups_create: write("Create group"),
  admin_groups_update: write("Update group", { idempotent: true }),
  admin_groups_delete: write("Delete group", { destructive: true }),
  admin_groups_add_item: write("Add item to group"),
  admin_groups_remove_item: write("Remove item from group"),

  // Admin: knowledge
  admin_knowledge_list: read("List knowledge entries"),
  admin_knowledge_get: read("Get knowledge entry"),
  admin_knowledge_create: write("Create knowledge entry"),
  admin_knowledge_update: write("Update knowledge entry", { idempotent: true }),
  admin_knowledge_delete: write("Delete knowledge entry", {
    destructive: true,
  }),

  // Admin: cold email, reply tracker, follow-ups
  admin_cold_email_get_settings: read("Get cold email settings"),
  admin_cold_email_update_settings: write("Update cold email settings", {
    idempotent: true,
  }),
  admin_cold_email_list_blocked: read("List blocked cold emails"),
  admin_cold_email_mark: write("Mark cold email"),
  admin_reply_tracker_get_settings: read("Get reply tracker settings"),
  admin_reply_tracker_update_settings: write("Update reply tracker settings", {
    idempotent: true,
  }),
  admin_follow_ups_list: read("List follow-ups"),
  admin_follow_ups_update: write("Update follow-up", { idempotent: true }),
  admin_follow_ups_delete: write("Delete follow-up", { destructive: true }),

  // Admin: digest, AI, account
  admin_digest_get: read("Get digest settings"),
  admin_digest_update_schedule: write("Update digest schedule", {
    idempotent: true,
  }),
  admin_digest_set_enabled: write("Enable or disable digest", {
    idempotent: true,
  }),
  admin_digest_update_items: write("Update digest items", {
    idempotent: true,
  }),
  admin_ai_get_settings: read("Get AI settings"),
  admin_ai_update_model: write("Update AI model", { idempotent: true }),
  admin_account_get: read("Get account settings"),
  admin_account_update: write("Update account settings", { idempotent: true }),

  // Admin: cleanup and unsubscribe
  admin_cleanup_list_jobs: read("List cleanup jobs"),
  admin_cleanup_create_job: write("Create cleanup job", { destructive: true }),
  admin_unsubscribe_list: read("List unsubscribe candidates"),
  admin_unsubscribe_request: write("Request unsubscribe", {
    destructive: true,
    openWorld: true,
  }),
};

function read(title: string): ToolMetadata {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

function write(
  title: string,
  options: {
    destructive?: boolean;
    idempotent?: boolean;
    openWorld?: boolean;
  } = {},
): ToolMetadata {
  return {
    title,
    readOnlyHint: false,
    destructiveHint: options.destructive ?? false,
    idempotentHint: options.idempotent ?? false,
    openWorldHint: options.openWorld ?? false,
  };
}
