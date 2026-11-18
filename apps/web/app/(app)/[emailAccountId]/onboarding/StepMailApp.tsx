"use client";

import { useLingui } from "@lingui/react/macro";
import { MailIcon } from "lucide-react";
import { OnboardingFeatureStep } from "./OnboardingFeatureStep";

export function StepMailApp({ onNext }: { onNext: () => void }) {
  const { t } = useLingui();

  return (
    <OnboardingFeatureStep
      illustration={
        <div className="flex size-32 items-center justify-center rounded-3xl bg-primary/10 text-primary">
          <MailIcon className="size-16" strokeWidth={1.5} />
        </div>
      }
      title={t`Meet your new email app`}
      description={t`Read and send email right here in the web mail app. Add the AI assistant anytime.`}
      onNext={onNext}
    />
  );
}
