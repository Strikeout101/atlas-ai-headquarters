import type { MessengerChannelType } from "../../../types";

export const CHANNEL_META: Record<
  MessengerChannelType,
  {
    label: string;
    targetHint: string;
    transportReady: boolean;
  }
> = {
  telegram: { label: "Telegram", targetHint: "chat_id", transportReady: true },
  whatsapp: {
    label: "WhatsApp",
    targetHint: "phone_number_id:recipient (e.g. 1234567890:+1555...)",
    transportReady: true,
  },
  discord: { label: "Discord", targetHint: "channel_id", transportReady: true },
  googlechat: {
    label: "Google Chat",
    targetHint: "spaces/AAA... (token is the webhook URL or key|token)",
    transportReady: true,
  },
  slack: { label: "Slack", targetHint: "channel_id", transportReady: true },
  signal: { label: "Signal", targetHint: "+8210..., group:<id>, username:<id>", transportReady: true },
  imessage: { label: "iMessage", targetHint: "Phone number or email (macOS Messages)", transportReady: true },
};

export function channelTargetHint(channel: MessengerChannelType): string {
  return CHANNEL_META[channel].targetHint;
}
