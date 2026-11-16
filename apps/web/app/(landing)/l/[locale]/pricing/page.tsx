import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { env } from "@/env";
import { getPricingMetadata } from "@/app/(landing)/pricing/pricing-metadata";
import { PricingPage } from "@/app/(landing)/pricing/PricingPage";
import { toLocale } from "@/utils/i18n/locales";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  return getPricingMetadata(toLocale(locale));
}

export default async function LocalizedPricingPage({ params }: Props) {
  // No billing on this deployment: plans and checkout lead into the app.
  if (env.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS) redirect("/welcome-redirect");
  const { locale } = await params;
  return <PricingPage locale={toLocale(locale)} />;
}
