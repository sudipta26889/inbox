"use client";

import Image from "next/image";
import {
  Section,
  SectionContent,
} from "@/components/new-landing/common/Section";
import {
  PageHeading,
  Paragraph,
} from "@/components/new-landing/common/Typography";
import { CallToAction } from "@/components/new-landing/CallToAction";
import { BlurFade } from "@/components/new-landing/common/BlurFade";
import { UnicornScene } from "@/components/new-landing/UnicornScene";
import {
  Badge,
  type BadgeVariant,
} from "@/components/new-landing/common/Badge";
import { useHeroLayoutVariant } from "@/hooks/useFeatureFlags";
import { BrandScroller } from "@/components/new-landing/BrandScroller";

interface HeroProps {
  badge?: React.ReactNode;
  badgeVariant?: BadgeVariant;
  children?: React.ReactNode;
  cta?: React.ReactNode;
  subtitle?: React.ReactNode;
  title?: React.ReactNode;
}

export function Hero({
  title,
  subtitle,
  badge,
  badgeVariant = "blue",
  children,
  cta,
}: HeroProps) {
  return (
    <Section className={badge ? "mt-7 md:mt-7" : "mt-10 md:mt-20"}>
      {badge ? (
        <BlurFade duration={0.4} delay={0}>
          <div className="flex justify-center mb-7">
            <Badge variant={badgeVariant}>{badge}</Badge>
          </div>
        </BlurFade>
      ) : null}
      <PageHeading>{title}</PageHeading>
      <BlurFade duration={0.4} delay={0.125 * 5}>
        <Paragraph size="lg" className={"max-w-[640px] mx-auto mt-6"}>
          {subtitle}
        </Paragraph>
      </BlurFade>
      <SectionContent noMarginTop className="mt-6 md:mt-8">
        <div className="space-y-3 mb-8">
          <BlurFade duration={0.4} delay={0.125 * 7}>
            {cta ?? <CallToAction showSalesButton={false} />}
          </BlurFade>
        </div>
        {children}
      </SectionContent>
    </Section>
  );
}

export function HeroVideoPlayer() {
  return (
    <BlurFade delay={0.125 * 9}>
      <div className="relative w-full">
        <div className="relative border border-[#EFEFEF] rounded-3xl md:rounded-[43px] overflow-hidden block">
          <Image
            src="/images/new-landing/video-thumbnail.png"
            alt="an organized inbox"
            width={2000}
            height={1000}
            className="w-full"
          />
          <UnicornScene className="h-[calc(100%+5px)] opacity-30" />
        </div>
      </div>
    </BlurFade>
  );
}

export function HeroContent() {
  const variant = useHeroLayoutVariant();

  if (variant === "social-proof-first") {
    return (
      <>
        <BrandScroller />
        <HeroVideoPlayer />
      </>
    );
  }

  return (
    <>
      <HeroVideoPlayer />
      <BrandScroller />
    </>
  );
}
