import type { Metadata } from "next";
import { BasicLayout } from "@/components/layouts/BasicLayout";
import { getBrandTitle } from "@/utils/branding";

export const metadata: Metadata = {
  title: getBrandTitle("Pricing"),
  description: "All features are free on this self-hosted instance.",
  alternates: { canonical: "/pricing" },
};

export default function PricingPage() {
  return (
    <BasicLayout>
      <div className="mx-auto max-w-2xl py-24 text-center">
        <h1 className="font-title text-4xl font-bold tracking-tight text-gray-900">
          All Features Free
        </h1>
        <p className="mt-6 text-lg text-gray-600">
          This is a self-hosted instance. All features are unlocked and
          available at no cost.
        </p>
      </div>
    </BasicLayout>
  );
}
