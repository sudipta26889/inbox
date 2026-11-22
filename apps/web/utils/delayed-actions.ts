import { ActionType } from "@/generated/prisma/enums";

// Action types that support delayed execution
const SUPPORTED_DELAYED_ACTIONS: ActionType[] = [
  ActionType.ARCHIVE,
  ActionType.LABEL,
  ActionType.REPLY,
  ActionType.SEND_EMAIL,
  ActionType.FORWARD,
  ActionType.MARK_READ,
  ActionType.STAR,
  ActionType.DELETE,
  ActionType.MOVE_FOLDER,
];

// A2A_NOTIFY has no delay setting in rules; the scheduler only retries a failed
// notification later.
export function canActionBeScheduled(actionType: ActionType): boolean {
  return canActionBeDelayed(actionType) || actionType === ActionType.A2A_NOTIFY;
}

export function canActionBeDelayed(actionType: ActionType): boolean {
  return SUPPORTED_DELAYED_ACTIONS.includes(actionType);
}
