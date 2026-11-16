import { redirect } from "next/navigation";
import { AppPricingLazy } from "@/app/(app)/premium/AppPricingLazy";
import { env } from "@/env";

export default function Premium() {
  // No billing on this deployment: plans and checkout lead into the app.
  if (env.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS) redirect("/welcome-redirect");
  return (
    <div className="bg-white pb-20">
      <AppPricingLazy showSkipUpgrade />
    </div>
  );
}
