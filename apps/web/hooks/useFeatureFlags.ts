import { env } from "@/env";

// ponytail: PostHog is gone, so each flag is just its env switch and every
// experiment resolves to its control arm. The variant hooks are kept as
// constants so the landing components reading them need no change.

export function useCleanerEnabled() {
  return env.NEXT_PUBLIC_CLEANER_ENABLED;
}

export function useFollowUpRemindersEnabled() {
  return env.NEXT_PUBLIC_FOLLOW_UP_REMINDERS_ENABLED;
}

export function useMeetingBriefsEnabled() {
  return env.NEXT_PUBLIC_MEETING_BRIEFS_ENABLED;
}

export function useIntegrationsEnabled() {
  return env.NEXT_PUBLIC_INTEGRATIONS_ENABLED;
}

export function useSmartFilingEnabled() {
  return env.NEXT_PUBLIC_SMART_FILING_ENABLED;
}

export type HeroVariant = "control" | "clean-up-in-minutes";
export type PricingVariant = "control" | "basic-business" | "business-basic";
export type PricingFrequencyDefault = "control" | "monthly";
export type TestimonialsVariant = "control" | "senja-widget";
export type HeroLayoutVariant = "control" | "social-proof-first";
export type WelcomePricingVariant = "control" | "two-tiers";

export function useHeroVariant(): HeroVariant {
  return "control";
}

export function useHeroVariantEnabled() {
  return false;
}

export function usePricingVariant(): PricingVariant {
  return "control";
}

export function usePricingFrequencyDefault(): PricingFrequencyDefault {
  return "control";
}

export function useTestimonialsVariant(): TestimonialsVariant {
  return "control";
}

export function useHeroLayoutVariant(): HeroLayoutVariant {
  return "control";
}

export function useWelcomePricingVariant(): WelcomePricingVariant {
  return "control";
}
