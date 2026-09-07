"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useAction } from "next-safe-action/hooks";
import { RadioTowerIcon } from "lucide-react";
import { useAccount } from "@/providers/EmailAccountProvider";
import { useEmailAccountFull } from "@/hooks/useEmailAccountFull";
import { LoadingContent } from "@/components/LoadingContent";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from "@/components/ui/item";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toastError, toastSuccess } from "@/components/Toast";
import { getActionErrorMessage } from "@/utils/error";
import { updateMqttSettingsAction } from "@/utils/actions/settings";
import {
  updateMqttSettingsBody,
  type UpdateMqttSettingsBody,
} from "@/utils/actions/settings.validation";

export function MqttSection() {
  const { data, isLoading, error, mutate } = useEmailAccountFull();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle className="flex items-center gap-2">
          <RadioTowerIcon className="size-4" />
          MQTT Agent Bus
        </ItemTitle>
        <ItemDescription>
          Publish unread counts, urgent alerts, digest and approval status to an
          MQTT broker so Home Assistant can react to your inbox.
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Dialog open={isOpen} onOpenChange={setIsOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">
              {data?.mqttEnabled ? "Manage" : "Enable"}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>MQTT Agent Bus</DialogTitle>
              <DialogDescription>
                Off by default. Nothing is published until you opt in and set a
                topic name.
              </DialogDescription>
            </DialogHeader>
            <LoadingContent
              loading={isLoading}
              error={error}
              loadingComponent={<Skeleton className="h-40 w-full" />}
            >
              {data && (
                <MqttSettingsForm
                  mqttEnabled={data.mqttEnabled}
                  mqttTopicSlug={data.mqttTopicSlug}
                  mqttIncludeDetail={data.mqttIncludeDetail}
                  mutate={mutate}
                  onSuccess={() => setIsOpen(false)}
                />
              )}
            </LoadingContent>
          </DialogContent>
        </Dialog>
      </ItemActions>
    </Item>
  );
}

function MqttSettingsForm({
  mqttEnabled,
  mqttTopicSlug,
  mqttIncludeDetail,
  mutate,
  onSuccess,
}: {
  mqttEnabled: boolean;
  mqttTopicSlug: string | null;
  mqttIncludeDetail: boolean;
  mutate: () => void;
  onSuccess: () => void;
}) {
  const { emailAccountId } = useAccount();

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<UpdateMqttSettingsBody>({
    resolver: zodResolver(updateMqttSettingsBody),
    defaultValues: {
      mqttEnabled,
      mqttTopicSlug: mqttTopicSlug ?? "",
      mqttIncludeDetail,
    },
  });

  const { execute, isExecuting } = useAction(
    updateMqttSettingsAction.bind(null, emailAccountId),
    {
      onSuccess: () => {
        toastSuccess({ description: "MQTT settings saved" });
        onSuccess();
      },
      onError: (error) => {
        toastError({
          description: getActionErrorMessage(error.error, {
            prefix: "Failed to save MQTT settings",
          }),
        });
      },
      onSettled: () => {
        mutate();
      },
    },
  );

  return (
    <form className="space-y-4" onSubmit={handleSubmit(execute)}>
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="mqtt-enabled">Publish to the bus</Label>
          <p className="text-xs text-muted-foreground">
            Only this account&apos;s own events are ever published.
          </p>
        </div>
        <Switch
          id="mqtt-enabled"
          checked={watch("mqttEnabled")}
          onCheckedChange={(checked) =>
            setValue("mqttEnabled", checked, { shouldValidate: true })
          }
          disabled={isExecuting}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="mqtt-slug">Topic name</Label>
        <Input
          id="mqtt-slug"
          placeholder="work"
          disabled={isExecuting}
          aria-invalid={!!errors.mqttTopicSlug}
          aria-describedby={
            errors.mqttTopicSlug ? "mqtt-slug-error" : undefined
          }
          {...register("mqttTopicSlug")}
        />
        {errors.mqttTopicSlug && (
          <p id="mqtt-slug-error" className="text-xs text-destructive">
            {errors.mqttTopicSlug.message}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Lowercase letters, numbers, - or _, up to 31 characters. Must be
          unique across all accounts. It becomes part of the MQTT topic and the
          Home Assistant entity IDs, so renaming or disabling clears the old
          topics.
        </p>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="mqtt-detail">Include subject and sender</Label>
          <p className="text-xs text-muted-foreground">
            Off by default. When on, urgent-mail payloads include the subject
            and sender address.
          </p>
        </div>
        <Switch
          id="mqtt-detail"
          checked={watch("mqttIncludeDetail")}
          onCheckedChange={(checked) =>
            setValue("mqttIncludeDetail", checked, { shouldValidate: true })
          }
          disabled={isExecuting}
        />
      </div>

      <Button type="submit" disabled={isExecuting} className="w-full">
        {isExecuting ? "Saving..." : "Save"}
      </Button>
    </form>
  );
}
