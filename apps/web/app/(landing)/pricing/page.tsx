import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { env } from "@/env";
import { getPricingMetadata } from "@/app/(landing)/pricing/pricing-metadata";
import { PricingPage } from "@/app/(landing)/pricing/PricingPage";

export const metadata: Metadata = getPricingMetadata("en");

export default function Page() {
  // No billing on this deployment: plans and checkout lead into the app.
  if (env.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS) redirect("/welcome-redirect");
  return <PricingPage locale="en" />;
}
