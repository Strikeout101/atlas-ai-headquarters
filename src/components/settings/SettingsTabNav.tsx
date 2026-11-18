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
    label: (t) => t({ en: "General" }),
  },
  {
    key: "business",
    group: 0,
    icon: SlidersHorizontal,
    label: (t) => t({ en: "Businesses" }),
  },
  {
    key: "security",
    group: 0,
    icon: ShieldCheck,
    label: (t) => t({ en: "Security" }),
  },
  {
    key: "cli",
    group: 1,
    icon: Wrench,
    label: (t) => t({ en: "CLI tools" }),
  },
  {
    key: "oauth",
    group: 1,
    icon: KeyRound,
    label: (t) => t({ en: "OAuth" }),
  },
  { key: "api", group: 1, icon: Cable, label: (t) => t({ en: "API" }) },
  {
    key: "gateway",
    group: 2,
    icon: Radio,
    label: (t) => t({ en: "Channels" }),
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
