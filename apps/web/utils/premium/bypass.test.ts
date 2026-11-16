// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";

// This deployment has no billing: NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS=true must
// open every premium gate for a user with no paid plan, so no upgrade, trial
// or credit UI shows and no credit is consumed.
const { envMock, mockUseUser } = vi.hoisted(() => ({
  envMock: {
    NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS: true,
    NEXT_PUBLIC_FREE_UNSUBSCRIBE_CREDITS: 0,
  },
  mockUseUser: vi.fn(),
}));

vi.mock("@/env", () => ({ env: envMock }));
vi.mock("@/utils/prisma");
vi.mock("@/hooks/useUser", () => ({ useUser: () => mockUseUser() }));

import { usePremium } from "@/hooks/usePremium";
import {
  getPremiumUserFilter,
  getUserTier,
  hasAiAccess,
  hasTierAccess,
  hasUnsubscribeAccess,
  isActivePremium,
  isPremium,
  isPremiumRecord,
} from "@/utils/premium";
import { assertHasAiAccess } from "@/utils/premium/limits";
import { checkHasAccess } from "@/utils/premium/server";
import { consumeUnsubscribeCredit } from "@/utils/premium/unsubscribe-credits";

const canceledTrial = {
  id: "premium-1",
  tier: null,
  stripeSubscriptionStatus: "canceled",
  lemonSqueezyRenewsAt: null,
  appleExpiresAt: null,
  appleRevokedAt: null,
  appleSubscriptionStatus: null,
  adminGrantTier: null,
  adminGrantExpiresAt: null,
  unsubscribeCredits: 0,
  unsubscribeMonth: null,
};

describe("premium bypass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({
      premium: canceledTrial,
    } as never);
  });

  it("opens every premium helper for a user with no plan", () => {
    expect(isPremium(null, "canceled")).toBe(true);
    expect(isPremiumRecord(null)).toBe(true);
    expect(isActivePremium(canceledTrial)).toBe(true);
    expect(getUserTier(null)).toBe("PROFESSIONAL_ANNUALLY");
    expect(hasAiAccess(null)).toBe(true);
    expect(hasUnsubscribeAccess(null, 0)).toBe(true);
    expect(
      hasTierAccess({ tier: null, minimumTier: "PROFESSIONAL_ANNUALLY" }),
    ).toBe(true);
    expect(getPremiumUserFilter()).toEqual({});
  });

  it("reports full access to the client, so no upgrade or trial UI renders", () => {
    mockUseUser.mockReturnValue({
      data: { premium: canceledTrial, hasAiApiKey: false },
      isLoading: false,
    });

    const { result } = renderHook(() => usePremium());

    expect(result.current).toMatchObject({
      isPremium: true,
      hasAiAccess: true,
      hasUnsubscribeAccess: true,
      isProPlanWithoutApiKey: false,
    });
  });

  it("allows server-side AI and feature checks", async () => {
    await expect(
      assertHasAiAccess({ userId: "user-1" }),
    ).resolves.toBeUndefined();
    await expect(
      checkHasAccess({ userId: "user-1", minimumTier: "PROFESSIONAL_ANNUALLY" }),
    ).resolves.toBe(true);
  });

  it("does not consume unsubscribe credits", async () => {
    await consumeUnsubscribeCredit({ userId: "user-1" });

    expect(prisma.premium.updateMany).not.toHaveBeenCalled();
    expect(prisma.premium.update).not.toHaveBeenCalled();
    expect(prisma.premium.create).not.toHaveBeenCalled();
  });
});
