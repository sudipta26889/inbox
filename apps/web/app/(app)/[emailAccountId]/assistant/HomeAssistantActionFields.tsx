import { useState } from "react";
import type { UseFormRegister, UseFormSetValue, UseFormWatch } from "react-hook-form";
import type { CreateRuleBody } from "@/utils/actions/rule.validation";
import { Input } from "@/components/Input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MutedText } from "@/components/Typography";
import { TooltipExplanation } from "@/components/TooltipExplanation";

type HomeAssistantIntegrationType = "webhook" | "mqtt" | "service_call" | "persistent_notification";

const INTEGRATION_TYPES: { value: HomeAssistantIntegrationType; label: string; description: string }[] = [
  {
    value: "webhook",
    label: "Webhook Trigger",
    description: "Trigger a Home Assistant webhook automation",
  },
  {
    value: "mqtt",
    label: "MQTT Publish",
    description: "Publish message to an MQTT topic",
  },
  {
    value: "service_call",
    label: "Service Call",
    description: "Call a Home Assistant service (lights, switches, notify, etc.)",
  },
  {
    value: "persistent_notification",
    label: "Persistent Notification",
    description: "Create a notification in Home Assistant UI",
  },
];

export function HomeAssistantActionFields({
  index,
  register,
  watch,
  setValue,
}: {
  index: number;
  register: UseFormRegister<CreateRuleBody>;
  watch: UseFormWatch<CreateRuleBody>;
  setValue: UseFormSetValue<CreateRuleBody>;
}) {
  const integrationType = watch(`actions.${index}.haIntegrationType`) as HomeAssistantIntegrationType | undefined;

  return (
    <div className="space-y-4">
      {/* Integration Type Selector */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Label htmlFor={`actions.${index}.haIntegrationType`}>
            Integration Type
          </Label>
          <TooltipExplanation
            text="Choose how to integrate with Home Assistant"
            size="sm"
          />
        </div>
        <Select
          value={integrationType || "webhook"}
          onValueChange={(value) =>
            setValue(`actions.${index}.haIntegrationType`, value)
          }
        >
          <SelectTrigger id={`actions.${index}.haIntegrationType`}>
            <SelectValue placeholder="Select integration type" />
          </SelectTrigger>
          <SelectContent>
            {INTEGRATION_TYPES.map((type) => (
              <SelectItem key={type.value} value={type.value}>
                <div>
                  <div className="font-medium">{type.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {type.description}
                  </div>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Webhook Fields */}
      {integrationType === "webhook" && (
        <div className="space-y-2">
          <Label htmlFor={`actions.${index}.haWebhookId`}>
            Webhook ID
          </Label>
          <Input
            type="text"
            name={`actions.${index}.haWebhookId`}
            registerProps={register(`actions.${index}.haWebhookId`)}
            placeholder="my_automation_trigger"
          />
          <MutedText className="text-xs">
            The webhook ID from your Home Assistant automation trigger. Create one
            in HA: Automations → Add → Trigger → Webhook
          </MutedText>
        </div>
      )}

      {/* MQTT Fields */}
      {integrationType === "mqtt" && (
        <div className="space-y-2">
          <Label htmlFor={`actions.${index}.haMqttTopic`}>
            MQTT Topic
          </Label>
          <Input
            type="text"
            name={`actions.${index}.haMqttTopic`}
            registerProps={register(`actions.${index}.haMqttTopic`)}
            placeholder="inbox/notifications/ai-news"
          />
          <MutedText className="text-xs">
            The MQTT topic to publish to. Email data will be sent as JSON payload.
          </MutedText>
        </div>
      )}

      {/* Service Call Fields */}
      {integrationType === "service_call" && (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`actions.${index}.haServiceDomain`}>
              Service Domain
            </Label>
            <Input
              type="text"
              name={`actions.${index}.haServiceDomain`}
              registerProps={register(`actions.${index}.haServiceDomain`)}
              placeholder="notify"
            />
            <MutedText className="text-xs">
              The domain of the service (e.g., notify, light, switch, automation)
            </MutedText>
          </div>

          <div className="space-y-2">
            <Label htmlFor={`actions.${index}.haServiceName`}>
              Service Name
            </Label>
            <Input
              type="text"
              name={`actions.${index}.haServiceName`}
              registerProps={register(`actions.${index}.haServiceName`)}
              placeholder="mobile_app_phone"
            />
            <MutedText className="text-xs">
              The service to call (e.g., mobile_app_phone, turn_on, trigger)
            </MutedText>
          </div>

          <div className="space-y-2">
            <Label htmlFor={`actions.${index}.haEntityId`}>
              Entity ID (Optional)
            </Label>
            <Input
              type="text"
              name={`actions.${index}.haEntityId`}
              registerProps={register(`actions.${index}.haEntityId`)}
              placeholder="light.living_room"
            />
            <MutedText className="text-xs">
              The entity to target (optional, depends on the service)
            </MutedText>
          </div>
        </div>
      )}

      {/* Persistent Notification Fields */}
      {integrationType === "persistent_notification" && (
        <div className="space-y-2">
          <MutedText className="text-sm">
            A notification will be created in Home Assistant with the email subject
            and preview. No additional configuration needed.
          </MutedText>
        </div>
      )}
    </div>
  );
}
