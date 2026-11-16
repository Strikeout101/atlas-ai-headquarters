import { Cable, KeyRound, Radio, ShieldCheck, SlidersHorizontal, Wrench, type LucideIcon } from "lucide-react";
import type { SettingsTab, TFunction } from "./types";

interface SettingsTabNavProps {
  tab: SettingsTab;
  setTab: (tab: SettingsTab) => void;
  t: TFunction;
}

/** Settings groups for the account, businesses, AI providers, and messaging channels. */
const TAB_ITEMS: Array<{ key: SettingsTab; icon: LucideIcon; label: (t: TFunction) => string; group: number }> = [
  {
    key: "general",
    group: 0,
    icon: SlidersHorizontal,
    label: (t) => t({ ko: "일반 설정", en: "General", ja: "一般設定", zh: "常规设置" }),
  },
  {
    key: "business",
    group: 0,
    icon: SlidersHorizontal,
    label: (t) => t({ ko: "사업 프로필", en: "Businesses", ja: "事業", zh: "业务" }),
  },
  {
    key: "security",
    group: 0,
    icon: ShieldCheck,
    label: (t) => t({ ko: "보안", en: "Security", ja: "セキュリティ", zh: "安全" }),
  },
  {
    key: "cli",
    group: 1,
    icon: Wrench,
    label: (t) => t({ ko: "CLI 도구", en: "CLI tools", ja: "CLI ツール", zh: "CLI 工具" }),
  },
  {
    key: "oauth",
    group: 1,
    icon: KeyRound,
    label: (t) => t({ ko: "OAuth 인증", en: "OAuth", ja: "OAuth 認証", zh: "OAuth 认证" }),
  },
  { key: "api", group: 1, icon: Cable, label: (t) => t({ ko: "API 연동", en: "API", ja: "API 連携", zh: "API 集成" }) },
  {
    key: "gateway",
    group: 2,
    icon: Radio,
    label: (t) => t({ ko: "채널 메시지", en: "Channels", ja: "チャネル", zh: "频道" }),
  },
];

export default function SettingsTabNav({ tab, setTab, t }: SettingsTabNavProps) {
  return (
    <div role="tablist" className="ax-tabs">
      {TAB_ITEMS.map(({ key, icon: Icon, label, group }, index) => [
        index > 0 && TAB_ITEMS[index - 1].group !== group ? (
          <span
            key={`divider-${key}`}
            aria-hidden
            className="-mx-2 my-2 w-px shrink-0 self-stretch"
            style={{ background: "var(--th-border)" }}
          />
        ) : null,
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
        </button>,
      ])}
    </div>
  );
}
