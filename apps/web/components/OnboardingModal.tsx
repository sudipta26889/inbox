"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocalStorage } from "usehooks-ts";
import { useModal } from "@/hooks/useModal";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function OnboardingModal({
  title,
  description,
  buttonProps,
}: {
  title: string;
  description: React.ReactNode;
  buttonProps?: React.ComponentProps<typeof Button>;
}) {
  const { isModalOpen, openModal, setIsModalOpen } = useModal();

  return (
    <>
      <Button onClick={openModal} className="text-nowrap" {...buttonProps}>
        Learn more
      </Button>

      <OnboardingModalDialog
        isModalOpen={isModalOpen}
        setIsModalOpen={setIsModalOpen}
        title={title}
        description={description}
      />
    </>
  );
}

export function OnboardingModalDialog({
  isModalOpen,
  setIsModalOpen,
  title,
  description,
}: {
  isModalOpen: boolean;
  setIsModalOpen: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
}) {
  return (
    <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}

export const useOnboarding = (feature: string) => {
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [hasViewedOnboarding, setHasViewedOnboarding] = useLocalStorage(
    `viewed${feature}Onboarding`,
    false,
  );

  useEffect(() => {
    if (!hasViewedOnboarding) {
      setIsOpen(true);
      setHasViewedOnboarding(true);
    }
  }, [setHasViewedOnboarding, hasViewedOnboarding]);

  const onClose = useCallback(() => {
    setIsOpen(false);
  }, []);

  return {
    isOpen,
    hasViewedOnboarding,
    setIsOpen,
    onClose,
  };
};
