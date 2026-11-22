import {
  createVoiceProvider,
  resolveVoiceRuntime,
  toVoiceStatus,
} from "@/utils/voice/factory";

export function getVoiceRuntime() {
  return resolveVoiceRuntime();
}

export function getVoiceStatus() {
  return toVoiceStatus(getVoiceRuntime());
}

export function getConfiguredVoiceProvider() {
  return createVoiceProvider(getVoiceRuntime());
}
