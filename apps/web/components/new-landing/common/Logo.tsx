import Image from "next/image";
import Link from "next/link";
import { BRAND_LOGO_URL, BRAND_NAME } from "@/utils/branding";

interface LogoProps {
  variant?: "default" | "mobile" | "glass";
}

function CustomLogo({
  logoUrl,
  variant = "default",
}: {
  logoUrl: string;
  variant?: LogoProps["variant"];
}) {
  const dimensions =
    variant === "mobile"
      ? { width: 98, height: 17 }
      : { width: 142, height: 19 };
  const sizeClass = variant === "mobile" ? "h-4 w-auto" : "h-5 w-auto";

  return (
    <Image
      src={logoUrl}
      alt={`${BRAND_NAME} logo`}
      width={dimensions.width}
      height={dimensions.height}
      className={sizeClass}
      unoptimized
    />
  );
}

function GlassLogo() {
  return (
    <Image
      src="/images/new-landing/inbox-glass.png"
      alt="Logo"
      width={142}
      height={19}
    />
  );
}

function DefaultLogo() {
  return (
    <span className="text-xl font-bold text-gray-900 tracking-tight">
      {BRAND_NAME}
    </span>
  );
}

function MobileLogo() {
  return (
    <span className="text-lg font-bold text-gray-900 tracking-tight">
      {BRAND_NAME}
    </span>
  );
}

export function Logo({ variant = "default" }: LogoProps) {
  if (BRAND_LOGO_URL) {
    return (
      <Link href="/">
        <CustomLogo logoUrl={BRAND_LOGO_URL} variant={variant} />
      </Link>
    );
  }

  return (
    <Link href="/">
      {variant === "default" ? (
        <DefaultLogo />
      ) : variant === "mobile" ? (
        <MobileLogo />
      ) : (
        <GlassLogo />
      )}
    </Link>
  );
}
