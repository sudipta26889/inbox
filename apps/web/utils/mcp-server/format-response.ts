/**
 * Format MCP tool responses as Markdown
 */

export function formatEmailAsMarkdown(email: {
  id: string;
  from: string;
  to?: string;
  cc?: string;
  subject: string;
  date: string;
  textPlain?: string;
  snippet?: string;
  attachments?: Array<{
    filename: string;
    mimeType: string;
    size: number;
    content?: {
      type: string;
      text?: string;
      pageCount?: number;
      error?: string;
    };
  }>;
}): string {
  let md = "## Email\n\n";
  md += `**From:** ${email.from}\n`;
  if (email.to) md += `**To:** ${email.to}\n`;
  if (email.cc) md += `**CC:** ${email.cc}\n`;
  md += `**Subject:** ${email.subject}\n`;
  md += `**Date:** ${email.date}\n`;
  md += `**ID:** \`${email.id}\`\n\n`;

  if (email.textPlain) {
    md += `### Body\n\n${email.textPlain}\n`;
  } else if (email.snippet) {
    md += `### Snippet\n\n${email.snippet}\n`;
  }

  // Format attachments
  if (email.attachments && email.attachments.length > 0) {
    md += `\n---\n\n### 📎 Attachments (${email.attachments.length})\n\n`;

    email.attachments.forEach((attachment, index) => {
      md += `#### ${index + 1}. ${attachment.filename}\n\n`;
      md += `- **Type:** ${attachment.mimeType}\n`;
      md += `- **Size:** ${(attachment.size / 1024).toFixed(2)} KB\n`;

      if (attachment.content) {
        if (attachment.content.error) {
          md += `- **Status:** ⚠️ ${attachment.content.error}\n`;
        } else if (attachment.content.text) {
          md += `- **Status:** ✅ Parsed successfully\n`;
          if (attachment.content.pageCount) {
            md += `- **Pages:** ${attachment.content.pageCount}\n`;
          }
          md += `\n**Content:**\n\n`;
          md += `\`\`\`\n${attachment.content.text}\n\`\`\`\n`;
        }
      }

      md += "\n";
    });
  }

  return md;
}

export function formatEmailListAsMarkdown(
  emails: Array<{
    id: string;
    from: string;
    subject: string;
    date: string;
    snippet?: string;
  }>,
): string {
  if (emails.length === 0) {
    return "No emails found.";
  }

  let md = `# Emails (${emails.length})\n\n`;

  emails.forEach((email, index) => {
    md += `## ${index + 1}. ${email.subject}\n\n`;
    md += `- **From:** ${email.from}\n`;
    md += `- **Date:** ${email.date}\n`;
    md += `- **ID:** \`${email.id}\`\n`;
    if (email.snippet) {
      md += `- **Snippet:** ${email.snippet}\n`;
    }
    md += "\n";
  });

  return md;
}

export function formatCalendarEventsAsMarkdown(
  events: Array<{
    id?: string;
    summary: string;
    start: any;
    end: any;
    location?: string;
    description?: string;
    attendees?: Array<{
      email?: string;
      name?: string;
      responseStatus?: string;
    }>;
  }>,
): string {
  if (events.length === 0) {
    return "No events found.";
  }

  let md = `# Calendar Events (${events.length})\n\n`;

  events.forEach((event, index) => {
    md += `## ${index + 1}. ${event.summary}\n\n`;

    const startTime =
      typeof event.start === "string"
        ? event.start
        : event.start?.dateTime || event.start?.date || "Unknown";
    const endTime =
      typeof event.end === "string"
        ? event.end
        : event.end?.dateTime || event.end?.date || "Unknown";

    md += `- **Start:** ${startTime}\n`;
    md += `- **End:** ${endTime}\n`;

    if (event.location) {
      md += `- **Location:** ${event.location}\n`;
    }

    if (event.description) {
      md += `- **Description:** ${event.description}\n`;
    }

    if (event.attendees && event.attendees.length > 0) {
      md += "- **Attendees:**\n";
      event.attendees.forEach((attendee) => {
        const name = attendee.name || attendee.email || "Unknown";
        const status = attendee.responseStatus
          ? ` (${attendee.responseStatus})`
          : "";
        md += `  - ${name}${status}\n`;
      });
    }

    md += "\n";
  });

  return md;
}

export function formatStatsAsMarkdown(stats: {
  period: string;
  stats: Array<{
    date: string;
    total: number;
    inbox: number;
    sent: number;
    read: number;
    unread: number;
  }>;
  summary: {
    totalEmails: number;
    totalInbox: number;
    totalSent: number;
    totalRead: number;
    totalUnread: number;
  };
}): string {
  let md = `# Email Statistics (${stats.period})\n\n`;

  md += "## Summary\n\n";
  md += `- **Total Emails:** ${stats.summary.totalEmails}\n`;
  md += `- **Inbox:** ${stats.summary.totalInbox}\n`;
  md += `- **Sent:** ${stats.summary.totalSent}\n`;
  md += `- **Read:** ${stats.summary.totalRead}\n`;
  md += `- **Unread:** ${stats.summary.totalUnread}\n\n`;

  if (stats.stats.length > 0) {
    md += "## By Period\n\n";
    md += "| Date | Total | Inbox | Sent | Read | Unread |\n";
    md += "|------|-------|-------|------|------|--------|\n";

    stats.stats.forEach((stat) => {
      md += `| ${stat.date} | ${stat.total} | ${stat.inbox} | ${stat.sent} | ${stat.read} | ${stat.unread} |\n`;
    });
  }

  return md;
}

export function formatToolResponse(toolName: string, result: any): string {
  try {
    switch (toolName) {
      case "search_emails":
        if (result.results && Array.isArray(result.results)) {
          return formatEmailListAsMarkdown(result.results);
        }
        break;

      case "get_email":
        // Check if this is a search result (Gmail search URL was provided)
        if (result._note && result.results && Array.isArray(result.results)) {
          let md = `# Gmail Search Results\n\n`;
          md += `> ${result._note}\n\n`;
          md += `**Search Query:** "${result.searchQuery}"\n`;
          md += `**Original URL:** ${result.originalUrl}\n\n`;
          md += `---\n\n`;
          md += formatEmailListAsMarkdown(result.results);
          return md;
        }
        return formatEmailAsMarkdown(result);

      case "send_email":
        return `# Email Sent Successfully\n\n- **Message ID:** \`${result.messageId}\`\n${result.threadId ? `- **Thread ID:** \`${result.threadId}\`\n` : ""}`;

      case "search_calendar":
        if (result.events && Array.isArray(result.events)) {
          return formatCalendarEventsAsMarkdown(result.events);
        }
        break;

      case "get_calendar_availability": {
        let md = "# Calendar Availability\n\n";
        md += `**Time Range:** ${result.timeRange?.start} to ${result.timeRange?.end}\n\n`;
        md += `**Total Busy Time:** ${Math.round(result.totalBusyMinutes || 0)} minutes\n\n`;

        if (result.busy && result.busy.length > 0) {
          md += "## Busy Periods\n\n";
          result.busy.forEach((period: any, index: number) => {
            md += `${index + 1}. **${period.summary}** (${period.start} - ${period.end})\n`;
          });
        }

        if (result.free && result.free.length > 0) {
          md += "\n## Free Periods\n\n";
          result.free.forEach((period: any, index: number) => {
            md += `${index + 1}. ${period.start} - ${period.end}\n`;
          });
        }
        return md;
      }

      case "get_email_stats":
        return formatStatsAsMarkdown(result);

      case "list_email_accounts":
        if (result.accounts && Array.isArray(result.accounts)) {
          if (result.accounts.length === 0) {
            return "No email accounts found.";
          }
          let md = `# Email Accounts (${result.count})\n\n`;
          result.accounts.forEach((account: any, index: number) => {
            const defaultBadge = account.isDefault ? " **(default)**" : "";
            md += `${index + 1}. **${account.email}**${defaultBadge}\n`;
            md += `   - Provider: ${account.provider}\n`;
            md += `   - ID: \`${account.id}\`\n\n`;
          });
          return md;
        }
        break;

      default:
        // Fallback to formatted JSON for unknown tools
        return `\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
    }

    // Fallback for cases where specific formatting didn't apply
    return `\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
  } catch (error) {
    // If markdown formatting fails, fallback to JSON
    return `\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
  }
}
