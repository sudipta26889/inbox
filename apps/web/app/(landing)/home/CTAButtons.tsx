"use client";

import { Button } from "@/components/Button";

export function CTAButtons() {
  return (
    <div className="flex flex-col md:flex-row justify-center mt-10 gap-2">
      <div>
        <Button
          size="2xl"
          color="blue"
          link={{ href: "/login" }}
        >
          Get Started for Free
        </Button>
      </div>
      <div>
        <Button
          size="2xl"
          color="transparent"
          link={{ href: "/sales", target: "_blank" }}
        >
          Talk to sales
        </Button>
      </div>
    </div>
  );
}
