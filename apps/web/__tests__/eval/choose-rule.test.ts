import { describe, test, expect, afterAll, vi } from "vitest";
import { SystemType } from "@/generated/prisma/enums";
import {
  describeEvalMatrix,
  shouldRunEvalTests,
  getEvalTimeout,
} from "@/__tests__/eval/models";
import { createEvalReporter } from "@/__tests__/eval/reporter";
import { aiChooseRule } from "@/utils/ai/choose-rule/ai-choose-rule";
import { CONVERSATION_TRACKING_INSTRUCTIONS } from "@/utils/reply-tracker/conversation-status-config";
import { getRuleConfig } from "@/utils/rule/consts";
import { getEmail, getRule } from "@/__tests__/helpers";
import { chooseRuleCases } from "@/__tests__/eval/choose-rule-cases";
import { colleagueWorkMailCases } from "@/__tests__/eval/colleague-work-mail-cases";
import { createScopedLogger } from "@/utils/logger";

// pnpm test-ai eval/choose-rule
// Multi-model: EVAL_MODELS=all pnpm test-ai eval/choose-rule

// Classification evals exercise real models without publishing synthetic usage externally.
vi.mock("@/utils/redis/usage", async (importActual) => ({
  ...(await importActual<typeof import("@/utils/redis/usage")>()),
  saveUsage: vi.fn(),
}));

vi.mock("@inboxzero/tinybird-ai-analytics", () => ({ publishAiCall: vi.fn() }));

const shouldRunEval = shouldRunEvalTests();
const TIMEOUT = getEvalTimeout(60_000);
const logger = createScopedLogger("eval-choose-rule");

// Default system rules — mirrors what aiChooseRule actually receives in production.
// Cold email is handled in a prior step and conversation status (to_reply/fyi/etc)
// is resolved in a later step. Step 2 sees these rules + the collapsed "Conversations" meta-rule.
const systemRule = (type: SystemType) => {
  const config = getRuleConfig(type);
  return getRule(config.instructions, [], config.name);
};

const newsletter = systemRule(SystemType.NEWSLETTER);
const marketing = systemRule(SystemType.MARKETING);
const calendar = systemRule(SystemType.CALENDAR);
const receipt = systemRule(SystemType.RECEIPT);
const notification = systemRule(SystemType.NOTIFICATION);
const otp = systemRule(SystemType.OTP);
const conversations = getRule(
  CONVERSATION_TRACKING_INSTRUCTIONS,
  [],
  "Conversations",
);

const rules = [
  newsletter,
  marketing,
  calendar,
  receipt,
  notification,
  otp,
  conversations,
];

const promotionalBoundaryCases = [
  {
    name: "founder coordinating their own launch",
    email: getEmail({
      from: "partner@launchstudio.example",
      subject: "Your launch campaign is ready for approval",
      content:
        "Hi, we've finished the landing page and promotional emails for your company's launch. Please review the attached campaign copy and confirm whether we can publish tomorrow. We still need your decision on the introductory offer before we send it to your subscribers.",
    }),
    expectedRule: "Conversations",
  },
  {
    name: "agency client requesting campaign changes",
    email: getEmail({
      from: "client@retailer.example",
      subject: "Changes to our summer sale ads",
      content:
        "Hi team, your agency manages our paid campaigns. Please replace the 20% discount with free shipping in this week's ads and send over the revised creative for approval. Can you also explain why conversions dropped yesterday? We need your recommendation before increasing the budget.",
    }),
    expectedRule: "Conversations",
  },
  {
    name: "automated alert about the user's advertising campaign",
    email: getEmail({
      from: "alerts@adplatform.example",
      subject: "Your launch ads have stopped running",
      content:
        "The campaign you manage, Spring Launch, has been paused because its payment method was declined. Your ads are no longer being served. Update your billing details to resume delivery. View affected campaigns in your advertising account.",
    }),
    expectedRule: "Notification",
  },
  {
    name: "subscriber dashboard magic link",
    email: getEmail({
      from: "Member Benefits <support@makersdigest.example>",
      subject: "Your magic link to unlock your member benefits",
      content:
        "Thanks for being a paid member of Makers Digest! Open your dashboard to activate the partner apps included with your membership. Unlock your benefits: https://members.makersdigest.example/auth/callback#token=synthetic-example. Enjoy creating with your new apps!",
    }),
    expectedRule: "OTP",
  },
  {
    name: "requested verification with an upsell",
    email: getEmail({
      from: "hello@canvascloud.example",
      subject: "Confirm your email and start creating",
      content:
        "Enter code 123456 to verify the account you just created. It expires in 10 minutes. Once verified, explore our premium templates or upgrade for unlimited designs.",
    }),
    expectedRule: "OTP",
  },
  {
    name: "account recovery in Spanish with promotional footer",
    email: getEmail({
      from: "cuentas@studio.example",
      subject: "Recupera el acceso a tu cuenta",
      content:
        "Recibimos tu solicitud para restablecer la contraseña. Continúa aquí: https://studio.example/reset?token=synthetic-example. El enlace caduca en 15 minutos. Descubre también nuestra oferta anual con un 30% de descuento.",
    }),
    expectedRule: "OTP",
  },
  {
    name: "optional member benefit promotion",
    email: getEmail({
      from: "Member Benefits <support@makersdigest.example>",
      subject: "Explore this month's free member apps",
      content:
        "Your membership includes a growing collection of partner apps. This month, try a new design tool and a writing assistant at no extra cost. Browse the offers any time at https://members.makersdigest.example/benefits. Pick something new to try!",
    }),
    expectedRule: "Marketing",
  },
  {
    name: "promotional urgency without an account obligation",
    email: getEmail({
      from: "offers@canvascloud.example",
      subject: "Action required: your exclusive offer expires tonight",
      content:
        "Claim 40% off an optional upgrade before midnight. Sign in to view the deal and unlock premium templates. Your current plan continues as usual if you skip this offer.",
    }),
    expectedRule: "Marketing",
  },
];

const multiRuleStressRules = [
  getRule(
    "Receipts, invoices, purchase confirmations, payment receipts, renewal receipts, and order summaries where a payment succeeded or an invoice is available.",
    [],
    "Receipts and invoices",
  ),
  getRule(
    "Billing problems that require attention, including failed payments, overdue invoices, declined cards, subscription cancellation warnings, or account suspension due to payment.",
    [],
    "Billing problems",
  ),
  getRule(
    "Security alerts about sign-ins, password resets, suspicious activity, account access changes, or identity verification.",
    [],
    "Security alerts",
  ),
  getRule(
    "Shipping and delivery updates, tracking numbers, package delays, courier notifications, or delivered package confirmations.",
    [],
    "Shipping updates",
  ),
  getRule(
    "Calendar invites, meeting requests, reschedules, cancellations, agenda changes, and emails asking to pick or confirm a meeting time.",
    [],
    "Calendar scheduling",
  ),
  getRule(
    "Direct human messages that ask the user for a reply, decision, approval, answer, or follow-up. Do not use for automated notifications.",
    [],
    "Needs reply",
  ),
  getRule(
    "Customer support messages from customers or users reporting bugs, account problems, feature confusion, outages affecting them, or requests for help.",
    [],
    "Customer support",
  ),
  getRule(
    "Product feedback, feature requests, user research notes, survey responses, and comments about what should be improved in the product.",
    [],
    "Product feedback",
  ),
  getRule(
    "Sales leads, partnership opportunities, procurement questions, pricing requests, pilot requests, and inbound commercial interest.",
    [],
    "Sales leads",
  ),
  getRule(
    "Promotional campaigns, discount offers, product launch announcements, webinar promotions, trials, upgrade pushes, and other marketing messages.",
    [],
    "Marketing promotions",
  ),
  getRule(
    "Recurring newsletters, digests, editorial roundups, blog post summaries, curated links, or subscription publications.",
    [],
    "Newsletters",
  ),
  getRule(
    "Project management updates, task assignments, milestone changes, sprint planning notes, issue tracker updates, or status reports.",
    [],
    "Project management",
  ),
  getRule(
    "Code review activity, pull request reviews, build failures, deployment status, repository notifications, or engineering CI updates.",
    [],
    "Code reviews",
  ),
  getRule(
    "Recruiting, hiring, candidate interviews, job applications, referrals, offer logistics, or interview scheduling.",
    [],
    "Hiring",
  ),
  getRule(
    "Travel confirmations and itinerary changes for flights, hotels, trains, car rentals, visas, or business trips.",
    [],
    "Travel",
  ),
  getRule(
    "Legal notices, compliance updates, privacy policy or terms changes, DPA requests, contract reviews, regulatory notices, or legal approval requests.",
    [],
    "Legal and compliance",
  ),
  getRule(
    "Software account notifications about the user's plan status, usage limits, account configuration changes, service changes, or administrative notices for the product account.",
    [],
    "Account notifications",
  ),
  getRule(
    "Product release notes, changelog updates, new feature announcements, platform improvements, and usage guidance for existing users.",
    [],
    "Product updates",
  ),
];

const multiRuleStressTestCases = [
  {
    name: "payment receipt with renewal language",
    email: getEmail({
      from: "team@harborworkspace.example",
      subject: "Receipt for your annual workspace renewal",
      content:
        "Your annual workspace plan renewed successfully. Invoice #INV-2048 is ready. Total paid: $348.00 using Visa ending in 4242. You can download the receipt from your billing dashboard.",
    }),
    expectedPrimaryRule: "Receipts and invoices",
    // Renewal explicitly reports plan status, so the account rule can also fit.
    allowedRuleNames: ["Receipts and invoices", "Account notifications"],
    maxRuleCount: 2,
  },
  {
    name: "security alert with no reply needed",
    email: getEmail({
      from: "notices@atlasid.example",
      subject: "New sign-in detected",
      content:
        "We detected a new sign-in to your account from Chrome on macOS. If this was you, no action is needed. If this was not you, reset your password and review account activity.",
    }),
    expectedPrimaryRule: "Security alerts",
    allowedRuleNames: ["Security alerts"],
    maxRuleCount: 1,
  },
  {
    name: "customer support request that needs a reply",
    email: getEmail({
      from: "morgan@northwind.example",
      subject: "Export job failing for our workspace",
      content:
        "Hi, our nightly export has failed three times with a timeout error. Could you check what is happening and let us know whether there is a workaround before tomorrow morning?",
    }),
    expectedPrimaryRule: "Customer support",
    allowedRuleNames: ["Customer support", "Needs reply"],
    maxRuleCount: 2,
  },
  {
    name: "webinar promotion with product language",
    email: getEmail({
      from: "events@flowdash.example",
      subject: "Join our automation webinar and save 20%",
      listUnsubscribe: "<https://flowdash.example/unsubscribe?id=promo>",
      content:
        "See the new automation dashboard in action during next week's webinar. Attendees receive 20% off their first three months. Reserve your seat or start a free trial today.",
    }),
    expectedPrimaryRule: "Marketing promotions",
    allowedRuleNames: ["Marketing promotions"],
    maxRuleCount: 1,
  },
  {
    name: "automated pull request notification",
    email: getEmail({
      from: "noreply@devforge.example",
      subject: "[repo/app] Review requested on pull request #128",
      content:
        "A teammate requested your review on pull request #128: Improve export retry handling. Files changed: 8. Checks are still running. View the pull request in the repository.",
    }),
    expectedPrimaryRule: "Code reviews",
    allowedRuleNames: ["Code reviews"],
    maxRuleCount: 1,
  },
  {
    name: "personal photo share with no requested action",
    email: getEmail({
      from: "alex@example.com",
      subject: "Photos from Saturday",
      content:
        "Here are the photos from Saturday. I uploaded them to a shared album so you can look whenever you have time. No need to reply.",
    }),
    expectedPrimaryRule: null,
    allowedRuleNames: [],
    maxRuleCount: 0,
  },
  {
    name: "operational office notice",
    email: getEmail({
      from: "frontdesk@riverside.example",
      subject: "Lobby entrance closed Friday afternoon",
      content:
        "The main lobby entrance will be closed Friday from 1 PM to 4 PM for maintenance. Please use the side entrance during that window. No action is required.",
    }),
    expectedPrimaryRule: null,
    allowedRuleNames: [],
    maxRuleCount: 0,
  },
];

const borderlineMultiRuleTestCases = [
  {
    name: "privacy update with product controls",
    email: getEmail({
      from: "updates@workspace.example",
      subject: "Updates to our privacy policy and data controls",
      content:
        "We updated our privacy policy to describe new data retention controls now available in your admin dashboard. No action is required, but account owners can review the new settings before they take effect next month.",
    }),
    acceptablePrimaryRuleNames: [
      "Legal and compliance",
      "Product updates",
      "Account notifications",
    ],
    allowedRuleNames: [
      "Legal and compliance",
      "Product updates",
      "Account notifications",
    ],
    maxRuleCount: 2,
  },
  {
    name: "product digest with upgrade CTA",
    email: getEmail({
      from: "updates@analytics.example",
      subject: "April digest: new dashboards, templates, and a Pro trial",
      listUnsubscribe: "<https://analytics.example/unsubscribe?id=digest>",
      content:
        "This month's digest covers the new executive dashboard, three reporting templates, and workflow tips from the product team. Want to try advanced exports? Start a 14-day Pro trial from your workspace.",
    }),
    acceptablePrimaryRuleNames: [
      "Newsletters",
      "Product updates",
      "Marketing promotions",
    ],
    allowedRuleNames: [
      "Newsletters",
      "Product updates",
      "Marketing promotions",
    ],
    maxRuleCount: 3,
  },
  {
    name: "trial ending notice with discount",
    email: getEmail({
      from: "no-reply@workspace.example",
      subject: "Your trial ends tomorrow - keep your workspace active",
      content:
        "Your workspace trial ends tomorrow. Add billing details to keep access to projects and exports. Use code SAVE20 before midnight to get 20% off your first paid month.",
    }),
    acceptablePrimaryRuleNames: [
      "Account notifications",
      "Billing problems",
      "Marketing promotions",
    ],
    allowedRuleNames: [
      "Account notifications",
      "Billing problems",
      "Marketing promotions",
    ],
    maxRuleCount: 3,
  },
  {
    name: "compliance webinar promotion",
    email: getEmail({
      from: "events@trustops.example",
      subject: "Webinar: prepare for new data residency rules",
      listUnsubscribe: "<https://trustops.example/unsubscribe?id=webinar>",
      content:
        "Join our legal and product teams for a webinar on upcoming data residency requirements. We'll cover policy changes, controls available in Enterprise plans, and a limited-time onboarding package for teams that need help before the deadline.",
    }),
    acceptablePrimaryRuleNames: [
      "Marketing promotions",
      "Legal and compliance",
      "Product updates",
    ],
    allowedRuleNames: [
      "Marketing promotions",
      "Legal and compliance",
      "Product updates",
    ],
    maxRuleCount: 3,
  },
  {
    name: "legal newsletter roundup",
    email: getEmail({
      from: "weekly@policybrief.example",
      subject: "Weekly privacy brief: enforcement trends and contract tips",
      listUnsubscribe: "<https://policybrief.example/unsubscribe?id=brief>",
      content:
        "This week's privacy brief covers new enforcement actions, contract negotiation tips for data processing addendums, and a roundup of state privacy law deadlines. Read the full analysis on our site.",
    }),
    acceptablePrimaryRuleNames: ["Newsletters", "Legal and compliance"],
    allowedRuleNames: ["Newsletters", "Legal and compliance"],
    maxRuleCount: 2,
  },
  {
    name: "dense customer expansion legal scheduling request",
    email: getEmail({
      from: "casey@northwind.example",
      subject: "Export issue, DPA review, and expansion call",
      content:
        "Hi, our export job is still timing out and we need help today. We're also reviewing the updated DPA before expanding to three more teams. Can you send pricing for the larger plan and schedule a call with our legal and operations leads tomorrow?",
    }),
    acceptablePrimaryRuleNames: [
      "Customer support",
      "Legal and compliance",
      "Sales leads",
      "Calendar scheduling",
      "Needs reply",
    ],
    allowedRuleNames: [
      "Customer support",
      "Legal and compliance",
      "Sales leads",
      "Calendar scheduling",
      "Needs reply",
    ],
    maxRuleCount: 5,
  },
  {
    name: "four-way legal sales scheduling reply request",
    email: getEmail({
      from: "jordan@ridgeway.example",
      subject: "DPA, pricing, and implementation call",
      content:
        "Hi, we're ready to evaluate the Enterprise plan. Could you send pricing for 75 seats, share your current DPA for legal review, and schedule a call with our operations team this week?",
    }),
    acceptablePrimaryRuleNames: [
      "Sales leads",
      "Legal and compliance",
      "Calendar scheduling",
      "Needs reply",
    ],
    allowedRuleNames: [
      "Sales leads",
      "Legal and compliance",
      "Calendar scheduling",
      "Needs reply",
    ],
    maxRuleCount: 4,
  },
];

describe.runIf(shouldRunEval)("Eval: Choose Rule", () => {
  const evalReporter = createEvalReporter({ evalName: "choose-rule" });

  describeEvalMatrix("choose-rule", (model, emailAccount) => {
    for (const tc of chooseRuleCases) {
      const expectedLabel = Array.isArray(tc.expectedRule)
        ? tc.expectedRule.join(" | ")
        : (tc.expectedRule ?? "no match");
      const testName = `${tc.email.from} / ${tc.email.subject} → ${expectedLabel}`;
      test(
        testName,
        async () => {
          const result = await aiChooseRule({
            email: tc.email,
            rules,
            emailAccount,
            logger,
          });

          const primaryRule = result.rules.find((r) => r.isPrimary);
          const actual =
            primaryRule?.rule.name ?? result.rules[0]?.rule.name ?? "no match";
          const acceptable = Array.isArray(tc.expectedRule)
            ? tc.expectedRule
            : [tc.expectedRule ?? "no match"];
          const pass = acceptable.includes(actual);

          evalReporter.record({
            testName,
            model: model.label,
            pass,
            expected: expectedLabel,
            actual,
          });

          if (tc.expectedRule === null) {
            expect(result.rules).toEqual([]);
          } else {
            expect(acceptable).toContain(actual);
          }
        },
        TIMEOUT,
      );
    }
  });

  // Accounts with conversation tracking off get no Conversations rule, so a
  // colleague's mail must fall through to no match rather than Notification.
  describeEvalMatrix(
    "choose-rule without conversation tracking",
    (model, emailAccount) => {
      const rulesWithoutConversations = rules.filter(
        (rule) => rule !== conversations,
      );

      for (const tc of colleagueWorkMailCases) {
        const expected = [tc.expectedRule].flat();
        const acceptable = expected.includes("Conversations")
          ? [...expected.filter((rule) => rule !== "Conversations"), "no match"]
          : expected;
        const testName = `without conversations: ${tc.email.from} / ${tc.email.subject} → ${acceptable.join(" | ")}`;
        test(
          testName,
          async () => {
            const result = await aiChooseRule({
              email: tc.email,
              rules: rulesWithoutConversations,
              emailAccount,
              logger,
            });
            const primaryRule = result.rules.find((r) => r.isPrimary);
            const actual =
              primaryRule?.rule.name ??
              result.rules[0]?.rule.name ??
              "no match";

            evalReporter.record({
              testName,
              model: model.label,
              pass: acceptable.includes(actual),
              expected: acceptable.join(" | "),
              actual,
            });
            expect(acceptable).toContain(actual);
          },
          TIMEOUT,
        );
      }
    },
  );

  describeEvalMatrix(
    "promotional boundary",
    (model, emailAccount) => {
      for (const tc of promotionalBoundaryCases) {
        test(
          tc.name,
          async () => {
            const result = await aiChooseRule({
              email: tc.email,
              rules,
              emailAccount,
              logger,
            });
            const actual = result.rules.map(({ rule }) => rule.name);
            const pass = actual.length === 1 && actual[0] === tc.expectedRule;

            evalReporter.record({
              testName: `promotional boundary: ${tc.name}`,
              model: model.label,
              pass,
              expected: tc.expectedRule,
              actual: actual.join(", ") || "no match",
            });

            expect(actual).toEqual([tc.expectedRule]);
          },
          TIMEOUT,
        );
      }
    },
    { multiRuleSelectionEnabled: true },
  );

  describeEvalMatrix(
    "choose-rule multi-rule false positives",
    (model, emailAccount) => {
      for (const tc of multiRuleStressTestCases) {
        test(
          `${tc.name} -> ${tc.expectedPrimaryRule ?? "no match"}`,
          async () => {
            const result = await aiChooseRule({
              email: tc.email,
              rules: multiRuleStressRules,
              emailAccount,
              logger,
            });

            const actualRuleNames = result.rules.map(({ rule }) => rule.name);
            const primaryRule = result.rules.find((r) => r.isPrimary);
            const actualPrimaryRule =
              primaryRule?.rule.name ?? result.rules[0]?.rule.name ?? null;
            const unexpectedRuleNames = actualRuleNames.filter(
              (ruleName) => !tc.allowedRuleNames.includes(ruleName),
            );
            const pass =
              actualPrimaryRule === tc.expectedPrimaryRule &&
              actualRuleNames.length <= tc.maxRuleCount &&
              unexpectedRuleNames.length === 0;

            evalReporter.record({
              testName: `multi-rule false positives: ${tc.name}`,
              model: model.label,
              pass,
              expected: [
                `primary=${tc.expectedPrimaryRule ?? "no match"}`,
                `allowed=${tc.allowedRuleNames.join(", ") || "none"}`,
                `max=${tc.maxRuleCount}`,
              ].join("; "),
              actual: [
                `primary=${actualPrimaryRule ?? "no match"}`,
                `selected=${actualRuleNames.join(", ") || "none"}`,
                `count=${actualRuleNames.length}`,
                `unexpected=${unexpectedRuleNames.join(", ") || "none"}`,
              ].join("; "),
            });

            expect(actualPrimaryRule).toBe(tc.expectedPrimaryRule);
            expect(actualRuleNames.length).toBeLessThanOrEqual(tc.maxRuleCount);
            expect(unexpectedRuleNames).toEqual([]);
          },
          TIMEOUT,
        );
      }
    },
    { multiRuleSelectionEnabled: true },
  );

  describeEvalMatrix(
    "choose-rule borderline multi-rule selection",
    (model, emailAccount) => {
      for (const tc of borderlineMultiRuleTestCases) {
        test(
          `${tc.name} -> max ${tc.maxRuleCount}`,
          async () => {
            const result = await aiChooseRule({
              email: tc.email,
              rules: multiRuleStressRules,
              emailAccount,
              logger,
            });

            const actualRuleNames = result.rules.map(({ rule }) => rule.name);
            const primaryRule = result.rules.find((r) => r.isPrimary);
            const actualPrimaryRule =
              primaryRule?.rule.name ?? result.rules[0]?.rule.name ?? null;
            const unexpectedRuleNames = actualRuleNames.filter(
              (ruleName) => !tc.allowedRuleNames.includes(ruleName),
            );
            const pass =
              actualPrimaryRule !== null &&
              tc.acceptablePrimaryRuleNames.includes(actualPrimaryRule) &&
              actualRuleNames.length <= tc.maxRuleCount &&
              unexpectedRuleNames.length === 0;

            evalReporter.record({
              testName: `borderline multi-rule: ${tc.name}`,
              model: model.label,
              pass,
              expected: [
                `primary one of=${tc.acceptablePrimaryRuleNames.join(", ")}`,
                `allowed=${tc.allowedRuleNames.join(", ")}`,
                `max=${tc.maxRuleCount}`,
              ].join("; "),
              actual: [
                `primary=${actualPrimaryRule ?? "no match"}`,
                `selected=${actualRuleNames.join(", ") || "none"}`,
                `count=${actualRuleNames.length}`,
                `unexpected=${unexpectedRuleNames.join(", ") || "none"}`,
              ].join("; "),
            });

            expect(actualPrimaryRule).not.toBeNull();
            expect(tc.acceptablePrimaryRuleNames).toContain(actualPrimaryRule);
            expect(actualRuleNames.length).toBeLessThanOrEqual(tc.maxRuleCount);
            expect(unexpectedRuleNames).toEqual([]);
          },
          TIMEOUT,
        );
      }
    },
    { multiRuleSelectionEnabled: true },
  );

  afterAll(() => {
    evalReporter.printReport();
  });
});
