import { useMemo } from "react";

type OnboardingAnalyticsProps = {
  step?: number;
  stepKey?: string;
  totalSteps?: number;
  nextStep?: number;
  nextStepKey?: string;
  destination?: string;
  isOptional?: boolean;
};

// ponytail: analytics are gone, but the onboarding and welcome flows call these
// from inside effects and memo dependency arrays. Keeping a stable no-op object
// avoids reworking those hooks for a behavioural no-change; fold the calls out
// of the call sites next time either flow is edited.
export function useOnboardingAnalytics(_variant: "onboarding" | "welcome") {
  return useMemo(
    () => ({
      onStart: (_properties?: number | OnboardingAnalyticsProps) => {},
      onStepViewed: (_properties?: number | OnboardingAnalyticsProps) => {},
      onNext: (_properties?: number | OnboardingAnalyticsProps) => {},
      onSkip: (_properties?: number | OnboardingAnalyticsProps) => {},
      onComplete: (_properties?: OnboardingAnalyticsProps) => {},
    }),
    [],
  );
}
