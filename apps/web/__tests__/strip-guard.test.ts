import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Owner rule: the product is "Inbox". No user-visible "Inbox Zero" in the UI,
// server output or outgoing mail, and no billing, upgrade or trial UI. Upstream
// code is kept (so upstream merges stay clean) and switched off by
// NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS; this test catches what a merge brings back.
const WEB_ROOT = join(import.meta.dirname, "..");
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

// Files that use upstream's billing UI or link to its plan pages. Each was
// checked to render nothing, or to grant access, when
// NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS is true: usePremium returns full access,
// so PremiumAlertWithData, PremiumModal openers and EndTrialButton never show,
// unsubscribe credits are not consumed (utils/premium/bypass.test.ts), and
// /pricing, /premium, /welcome-upgrade and /checkout-complete redirect into
// the app (app/(landing)/pricing/billing-off.test.ts). A new file here,
// usually from an upstream merge, fails this test until it is checked the
// same way and added.
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
  "app/(app)/[emailAccountId]/mail/page.tsx",
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
  "app/(app)/premium/AppPricingLazy.tsx",
  "app/(app)/premium/ManageSubscription.tsx",
  "app/(app)/premium/PremiumModal.tsx",
  "app/(app)/premium/Pricing.tsx",
  "app/(app)/premium/page.tsx",
  "app/(app)/settings/SettingsContent.tsx",
  "app/(landing)/home/Footer.tsx",
  "app/(landing)/home/HomePage.tsx",
  "app/(landing)/l/[locale]/pricing/page.tsx",
  "app/(landing)/pricing/PricingFAQs.tsx",
  "app/(landing)/pricing/PricingPage.tsx",
  "app/(landing)/pricing/page.tsx",
  "app/(landing)/pricing/pricing-metadata.ts",
  "app/(landing)/welcome-upgrade/WelcomeUpgradePricing.tsx",
  "app/(landing)/welcome-upgrade/page.tsx",
  "app/(landing)/welcome/form.tsx",
  "app/api/stripe/success/route.ts",
  "app/api/user/trial-preview/route.ts",
  "components/ContinueWhenSubscribed.tsx",
  "components/EndTrialButton.tsx",
  "components/NavUser.tsx",
  "components/PremiumAlert.tsx",
  "components/PremiumCard.tsx",
  "components/UpgradeToPlusButton.tsx",
  "components/assistant-chat/message-part.tsx",
  "components/new-landing/HeaderLinks.tsx",
  "components/new-landing/sections/Pricing.tsx",
  "hooks/useAiAutomationStatus.ts",
  "hooks/useAnalytics.ts",
  "hooks/usePremium.ts",
  "utils/actions/premium.ts",
  "utils/agent-markdown/content.ts",
  "utils/i18n/landing.ts",
  "utils/llms/model-usage-guard.ts",
];

const BILLING_UI_NAMES =
  /\b(usePremium|PremiumModal|usePremiumModal|PremiumAlertWithData|decrementUnsubscribeCredit\w*|AiAutomationStatusBanner|EndTrialButton|Pricing|PricingPage|AppPricing\w*)\b|trial-preview|"\/pricing"|"\/premium"|"\/welcome-upgrade"/;

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

  // A catalog entry renders only while its msgid matches a source string, and
  // no source says "Inbox Zero" any more. So a translation may name it only
  // in a stale entry whose msgid still does.
  it('translates no message into "Inbox Zero"', () => {
    const localesDir = join(WEB_ROOT, "locales");
    const hits = readdirSync(localesDir).flatMap((locale) =>
      readdirSync(join(localesDir, locale))
        .filter((name) => name.endsWith(".po"))
        .flatMap((name) =>
          readFileSync(join(localesDir, locale, name), "utf8")
            .split("\n\n")
            .filter((entry) => {
              const [msgid, msgstr = ""] = entry.split(/^msgstr /m);
              return (
                msgstr.includes("Inbox Zero") && !msgid.includes("Inbox Zero")
              );
            })
            .map((entry) => `${locale}/${name}: ${entry.split("\n").at(-1)}`),
        ),
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

  it("has no upstream founder email address, env defaults included", () => {
    const hits = [...files, join(WEB_ROOT, "env.ts")]
      .filter((file) => readFileSync(file, "utf8").includes("elie@"))
      .map((file) => relative(REPO_ROOT, file));

    expect(hits).toEqual([]);
  });

  // Upstream's promotions for apps that are not shipped here, and demo videos
  // of upstream's product, stay off behind one constant.
  describe("upstream promos", () => {
    const read = (path: string) => readFileSync(join(WEB_ROOT, path), "utf8");

    it("the switch is off", () => {
      expect(read("utils/upstream-promos.ts")).toMatch(
        /export const SHOW_UPSTREAM_PROMOS = false;/,
      );
    });

    it("the email-app announcement is shown only behind the switch", () => {
      const source = read("utils/announcements.tsx");
      const launch = source.slice(
        source.indexOf('id: "email-client-launch"'),
        source.indexOf("details: ["),
      );

      expect(launch).toMatch(/enabled: SHOW_UPSTREAM_PROMOS,/);
    });

    it('"Get the app" is rendered only behind the switch', () => {
      const source = read("components/SideNav.tsx");

      expect(source).toMatch(
        /SHOW_UPSTREAM_PROMOS && \(\s*<SideNavMenu items=\{getTheAppLinks\}/,
      );
      expect(source.match(/items=\{getTheAppLinks\}/g)).toHaveLength(1);
    });

    it("the app download page redirects away", () => {
      expect(read("app/(landing)/app/page.tsx")).toMatch(
        /if \(!SHOW_UPSTREAM_PROMOS\) redirect\("\/welcome-redirect"\);/,
      );
    });

    it('"Watch demo" renders nothing', () => {
      expect(read("components/PageHeaderVideoButton.tsx")).toMatch(
        /if \(!SHOW_UPSTREAM_PROMOS\) return null;/,
      );
    });

    it("the footer's app links are listed only behind the switch", () => {
      const source = read("app/(landing)/home/Footer.tsx");

      expect(source).toMatch(
        /SHOW_UPSTREAM_PROMOS\s*\?\s*\[\s*\{ name: msg`Email App`, href: "\/email-client" \},\s*\{ name: msg`Mobile App`, href: "\/mobile-app" \},\s*\]\s*:\s*\[\]/,
      );
      expect(source.match(/href: "\/email-client"/g)).toHaveLength(1);
      expect(source.match(/href: "\/mobile-app"/g)).toHaveLength(1);
    });

    it("the onboarding mail step names no desktop or phone app and plays no upstream video", () => {
      const source = read(
        "app/(app)/[emailAccountId]/onboarding/StepMailApp.tsx",
      );

      expect(source).not.toMatch(/desktop|iphone|android|mobile/i);
      expect(source).not.toMatch(
        /AnnouncementVideo|EMAIL_CLIENT_LAUNCH_VIDEO_ID|playbackId/,
      );
    });

    it("the footer's Download link is listed only behind the switch", () => {
      const source = read("app/(landing)/home/Footer.tsx");

      expect(source).toMatch(
        /SHOW_UPSTREAM_PROMOS\s*\?\s*\[\{ name: msg`Download`, href: "\/download" \}\]\s*:\s*\[\]/,
      );
      expect(source.match(/href: "\/download"/g)).toHaveLength(1);
    });

    it("the desktop update menu item renders nothing", () => {
      expect(read("components/DesktopUpdateMenuItem.tsx")).toMatch(
        /if \(!SHOW_UPSTREAM_PROMOS\) return null;/,
      );
    });

    it("any other file with the promo wording knows about the switch", () => {
      const offenders = files
        .filter((file) =>
          /\b(Download the app|Get the app|Watch demo)\b/.test(
            readFileSync(file, "utf8"),
          ),
        )
        .filter(
          (file) =>
            !readFileSync(file, "utf8").includes("SHOW_UPSTREAM_PROMOS"),
        )
        .map((file) => relative(REPO_ROOT, file));

      expect(offenders).toEqual([]);
    });
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

  it("hides the landing header's pricing link when billing is off", () => {
    const headerLinks = readFileSync(
      join(WEB_ROOT, "components/new-landing/HeaderLinks.tsx"),
      "utf8",
    );

    expect(headerLinks).toMatch(
      /NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS\s*\?\s*\[\]\s*:\s*\[\{ name: msg`Pricing`, href: "\/pricing" \}\]/,
    );
  });

  it.each([
    "deploy/stack.yml",
    "deploy/stack.staging.yml",
  ])("%s does not turn premium checks back on", (file) => {
    const content = readFileSync(join(REPO_ROOT, file), "utf8");

    expect(content).not.toMatch(/NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS:\s*"?false/);
  });

  // The dev bypass can sign in as a real user. It must never be configurable
  // anywhere a deployed instance reads its environment from.
  it.each([
    "deploy/stack.yml",
    "deploy/stack.staging.yml",
    ".github/workflows/deploy.yml",
    ".github/workflows/deploy-staging.yml",
  ])("%s has no dev login bypass setting at all", (file) => {
    expect(readFileSync(join(REPO_ROOT, file), "utf8")).not.toMatch(
      /LOCAL_AUTH_BYPASS|LOCAL_PREVIEW/,
    );
  });

  it.each([
    "deploy/stack.yml",
    "deploy/stack.staging.yml",
    ".github/workflows/deploy.yml",
    ".github/workflows/deploy-staging.yml",
    ".github/workflows/local-bypass-smoke.yml",
  ])("%s sets neither the bypass user email nor the preview flag", (file) => {
    const content = readFileSync(join(REPO_ROOT, file), "utf8");

    expect(content).not.toContain("LOCAL_AUTH_BYPASS_USER_EMAIL");
    expect(content).not.toContain("LOCAL_PREVIEW");
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
