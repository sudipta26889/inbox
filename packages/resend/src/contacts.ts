// NOTE: Contact/Audience management is a Resend-specific feature
// If using SMTP, these functions will not work.
// You may want to implement an alternative contact management solution
// or simply disable this functionality when using SMTP.

// Legacy: This will be removed when Resend is fully deprecated
// For now, it's kept for backward compatibility

export async function createContact(options: {
  email: string;
  audienceId?: string;
}) {
  // SMTP doesn't have audience management - this is Resend-specific
  console.warn("Contact management not available with SMTP. This feature requires Resend.");
  return;
}

export async function deleteContact(options: {
  email: string;
  audienceId?: string;
}) {
  // SMTP doesn't have audience management - this is Resend-specific
  console.warn("Contact management not available with SMTP. This feature requires Resend.");
  return;
}
