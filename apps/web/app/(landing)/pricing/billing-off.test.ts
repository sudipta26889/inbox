import { describe, expect, it, vi } from "vitest";

// No billing on this deployment: with NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS the
// plan, upgrade and checkout pages send people into the app instead.
vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS: true,
    NEXT_PUBLIC_BASE_URL: "https://inbox.example.com",
  },
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  notFound: vi.fn(),
}));
vi.mock("@/utils/auth", () => ({ auth: vi.fn() }));
vi.mock("@/utils/prisma");

import PricingPage from "@/app/(landing)/pricing/page";
import LocalizedPricingPage from "@/app/(landing)/l/[locale]/pricing/page";
import PremiumPage from "@/app/(app)/premium/page";
import WelcomeUpgradePage from "@/app/(landing)/welcome-upgrade/page";
import CheckoutCompletePage from "@/app/(landing)/checkout-complete/page";
import { auth } from "@/utils/auth";

describe("billing pages with premium checks bypassed", () => {
  it.each([
    ["/pricing", () => PricingPage()],
    [
      "/l/de/pricing",
      () => LocalizedPricingPage({ params: Promise.resolve({ locale: "de" }) }),
    ],
    ["/premium", () => PremiumPage()],
    ["/welcome-upgrade", () => WelcomeUpgradePage()],
    [
      "/checkout-complete",
      () =>
        CheckoutCompletePage({
          searchParams: Promise.resolve({ session_id: "cs_test" }),
        }),
    ],
  ])("%s redirects to the app", async (_path, render) => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "u1" } } as never);

    await expect(async () => render()).rejects.toThrow(
      "redirect:/welcome-redirect",
    );
  });
});
