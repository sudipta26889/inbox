import { PlusIcon } from "lucide-react";
import { RulesPrompt } from "@/app/(app)/[emailAccountId]/assistant/RulesPromptNew";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { VisuallyHidden } from "@/components/ui/visually-hidden";

export function AddRuleDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" Icon={PlusIcon}>
          Add Rule
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-5xl">
        <VisuallyHidden>
          <DialogTitle>Add Rule</DialogTitle>
        </VisuallyHidden>
        <RulesPrompt />
      </DialogContent>
    </Dialog>
  );
}
