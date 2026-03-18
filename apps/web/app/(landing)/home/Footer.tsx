import Link from "next/link";
import { BRAND_NAME } from "@/utils/branding";

// Minimal footer navigation for self-hosted deployment
export const footerNavigation = {
  main: [] as { name: string; href: string; target?: string }[],
  useCases: [] as { name: string; href: string; target?: string }[],
  industries: [] as { name: string; href: string; target?: string }[],
  compare: [] as { name: string; href: string; target?: string }[],
  tools: [] as { name: string; href: string; target?: string }[],
  support: [] as { name: string; href: string; target?: string }[],
  company: [] as { name: string; href: string; target?: string }[],
  legal: [
    { name: "Terms", href: "/terms" },
    { name: "Privacy", href: "/privacy" },
  ],
  social: [] as {
    name: string;
    href: string;
    target?: string;
    icon: React.FC<React.SVGProps<SVGSVGElement>>;
  }[],
};

export function Footer() {
  return (
    <footer className="relative">
      <div className="mx-auto max-w-7xl overflow-hidden px-6 py-12 lg:px-8">
        <div className="flex flex-wrap justify-center gap-x-6 gap-y-2">
          {footerNavigation.legal.map((item) => (
            <Link
              key={item.name}
              href={item.href}
              className="text-sm leading-6 text-gray-600 hover:text-gray-900"
            >
              {item.name}
            </Link>
          ))}
        </div>
        <p className="mt-6 text-center text-xs leading-5 text-gray-500">
          Self-hosted {BRAND_NAME} AI Email Assistant
        </p>
      </div>
    </footer>
  );
}
