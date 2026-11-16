import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Owner rule: the product is "Inbox". No user-visible "Inbox Zero" in the UI,
// server output or outgoing mail, and no billing, upgrade or trial UI. Upstream
// code is kept (so upstream merges stay clean) and switched off by
// NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS; this test catches what a merge brings back.
const WEB_ROOT = join(__dirname, "..");
const REPO_ROOT = join(WEB_ROOT, "..", "..");

// Code that renders pages, answers requests or sends mail.
const RENDERED_DIRS = [
  "apps/web/app",
  "apps/web/components",
  "apps/web/providers",
  "apps/web/hooks",
  "apps/web/utils",
  "apps/web/ee",
  "apps/web/store",
  "packages/transactional-email/emails",
  "packages/transactional-email/src",
  "packages/mail-ui/src",
];

// White-label checks compare against upstream's own name; they render nothing.
const BRAND_COMPARISON = /BRAND_NAME === "Inbox Zero"/;

// Files that use upstream's billing UI. Each was checked to render nothing, or
// to grant access, when NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS is true: usePremium
// returns full access, so PremiumAlertWithData, PremiumModal openers and
// EndTrialButton never show, and unsubscribe credits are not consumed (see
// utils/premium/bypass.test.ts). A new file here, usually from an upstream
// merge, fails this test until it is checked the same way and added.
const REVIEWED_BILLING_UI_FILES = [
  "app/(app)/AiAutomationStatusBanner.tsx",
  "app/(app)/[emailAccountId]/assistant/BulkRunRules.tsx",
  "app/(app)/[emailAccountId]/assistant/ProcessRules.tsx",
  "app/(app)/[emailAccountId]/assistant/RuleForm.tsx",
  "app/(app)/[emailAccountId]/assistant/knowledge/KnowledgeForm.tsx",
  "app/(app)/[emailAccountId]/assistant/settings/DigestSetting.tsx",
  "app/(app)/[emailAccountId]/briefs/page.tsx",
  "app/(app)/[emailAccountId]/bulk-unsubscribe/BulkActions.tsx",
  "app/(app)/[emailAccountId]/bulk-unsubscribe/BulkUnsubscribeSection.tsx",
  "app/(app)/[emailAccountId]/bulk-unsubscribe/hooks.ts",
  "app/(app)/[emailAccountId]/channels/Channels.tsx",
  "app/(app)/[emailAccountId]/clean/IntroStep.tsx",
  "app/(app)/[emailAccountId]/integrations/IntegrationsPremiumAlert.tsx",
  "app/(app)/[emailAccountId]/integrations/page.tsx",
  "app/(app)/[emailAccountId]/mail/ListSenderCommands.tsx",
  "app/(app)/[emailAccountId]/mail/ThreadActionsMenu.tsx",
  "app/(app)/[emailAccountId]/mail/use-unsubscribe-sender.ts",
  "app/(app)/[emailAccountId]/meetings/page.tsx",
  "app/(app)/[emailAccountId]/onboarding/StepBulkUnsubscribe.tsx",
  "app/(app)/[emailAccountId]/onboarding/StepInboxProcessed.tsx",
  "app/(app)/[emailAccountId]/onboarding/useCompleteOnboarding.ts",
  "app/(app)/[emailAccountId]/settings/BillingSection.tsx",
  "app/(app)/[emailAccountId]/settings/DeleteSection.tsx",
  "app/(app)/[emailAccountId]/smart-categories/CategorizeWithAiButton.tsx",
  "app/(app)/[emailAccountId]/smart-categories/Uncategorized.tsx",
  "app/(app)/[emailAccountId]/smart-categories/page.tsx",
  "app/(app)/[emailAccountId]/usage/usage.tsx",
  "app/(app)/accounts/page.tsx",
  "app/(app)/layout.tsx",
  "app/(app)/license/page.tsx",
  "app/(app)/premium/ManageSubscription.tsx",
  "app/(app)/premium/PremiumModal.tsx",
  "app/(app)/premium/Pricing.tsx",
  "app/(app)/settings/SettingsContent.tsx",
  "app/(landing)/welcome/form.tsx",
  "app/api/user/trial-preview/route.ts",
  "components/ContinueWhenSubscribed.tsx",
  "components/EndTrialButton.tsx",
  "components/PremiumAlert.tsx",
  "components/UpgradeToPlusButton.tsx",
  "components/assistant-chat/message-part.tsx",
  "hooks/useAiAutomationStatus.ts",
  "hooks/usePremium.ts",
  "utils/actions/premium.ts",
];

const BILLING_UI_NAMES =
  /\b(usePremium|PremiumModal|usePremiumModal|PremiumAlertWithData|decrementUnsubscribeCredit\w*|AiAutomationStatusBanner|EndTrialButton)\b|trial-preview/;

describe("strip guard", () => {
  const files = RENDERED_DIRS.flatMap((dir) =>
    listSourceFiles(join(REPO_ROOT, dir)),
  );

  it("scans the rendered code", () => {
    expect(files.length).toBeGreaterThan(1000);
  });

  it('has no user-visible "Inbox Zero"', () => {
    const hits = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, index) => ({ line, index }))
        .filter(
          ({ line }) =>
            line.includes("Inbox Zero") &&
            !isComment(line) &&
            !BRAND_COMPARISON.test(line),
        )
        .map(({ index }) => `${relative(REPO_ROOT, file)}:${index + 1}`),
    );

    expect(hits).toEqual([]);
  });

  it("sends no mail that links to the upstream product site", () => {
    const hits = files
      .filter((file) => relative(REPO_ROOT, file).startsWith("packages/"))
      .filter((file) => readFileSync(file, "utf8").includes("getinboxzero"))
      .map((file) => relative(REPO_ROOT, file));

    expect(hits).toEqual([]);
  });

  it("names the product Inbox by default", () => {
    const envSource = readFileSync(join(WEB_ROOT, "env.ts"), "utf8");

    expect(envSource).toContain(
      'NEXT_PUBLIC_BRAND_NAME: z.string().trim().min(1).default("Inbox")',
    );
    expect(envSource).toMatch(
      /NEXT_PUBLIC_BRAND_LOGO_URL: z\s*\.string\(\)\s*\.optional\(\)\s*\.default\("\/images\/logos\/email-agent-logo\.png"\)/,
    );
  });

  it("uses billing UI only in files checked against the bypass flag", () => {
    const billingFiles = files
      .filter((file) => file.startsWith(WEB_ROOT))
      .filter((file) => BILLING_UI_NAMES.test(readFileSync(file, "utf8")))
      .map((file) => relative(WEB_ROOT, file))
      .sort();

    expect(billingFiles).toEqual([...REVIEWED_BILLING_UI_FILES].sort());
  });

  it.each([
    "deploy/stack.yml",
    "deploy/stack.staging.yml",
  ])("%s does not turn premium checks back on", (file) => {
    const content = readFileSync(join(REPO_ROOT, file), "utf8");

    expect(content).not.toMatch(/NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS:\s*"?false/);
  });

  it.each([
    ".github/workflows/deploy.yml",
    ".github/workflows/deploy-staging.yml",
  ])("%s builds with premium checks bypassed", (file) => {
    const content = readFileSync(join(REPO_ROOT, file), "utf8");

    expect(content).toContain("NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS=true");
  });
});

function isComment(line: string) {
  return /^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line);
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "__tests__" || name === "generated")
      return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listSourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)
      ? [path]
      : [];
  });
}
