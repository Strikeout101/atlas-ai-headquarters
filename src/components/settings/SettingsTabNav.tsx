import { Cable, KeyRound, Radio, Server, SlidersHorizontal, Wrench, type LucideIcon } from "lucide-react";
import type { SettingsTab, TFunction } from "./types";

interface SettingsTabNavProps {
  tab: SettingsTab;
  setTab: (tab: SettingsTab) => void;
  t: TFunction;
}

const TAB_ITEMS: Array<{ key: SettingsTab; icon: LucideIcon; label: (t: TFunction) => string }> = [
  {
    key: "general",
    icon: SlidersHorizontal,
    label: (t) => t({ ko: "일반 설정", en: "General", ja: "一般設定", zh: "常规设置" }),
  },
  { key: "cli", icon: Wrench, label: (t) => t({ ko: "CLI 도구", en: "CLI tools", ja: "CLI ツール", zh: "CLI 工具" }) },
  {
    key: "oauth",
    icon: KeyRound,
    label: (t) => t({ ko: "OAuth 인증", en: "OAuth", ja: "OAuth 認証", zh: "OAuth 认证" }),
  },
  { key: "api", icon: Cable, label: (t) => t({ ko: "API 연동", en: "API", ja: "API 連携", zh: "API 集成" }) },
  { key: "gateway", icon: Radio, label: (t) => t({ ko: "채널 메시지", en: "Channels", ja: "チャネル", zh: "频道" }) },
  {
    key: "ssh",
    icon: Server,
    label: (t) => t({ ko: "SSH 호스트", en: "SSH hosts", ja: "SSH ホスト", zh: "SSH 主机" }),
  },
];

export default function SettingsTabNav({ tab, setTab, t }: SettingsTabNavProps) {
  return (
    <div role="tablist" className="ax-tabs">
      {TAB_ITEMS.map(({ key, icon: Icon, label }) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={tab === key}
          onClick={() => setTab(key)}
          className="ax-tab"
        >
          <Icon size={15} strokeWidth={1.75} />
          {label(t)}
        </button>
      ))}
    </div>
  );
}
