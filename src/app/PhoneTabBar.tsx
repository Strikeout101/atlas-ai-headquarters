import { Menu } from "lucide-react";
import { useI18n } from "../i18n";
import { NAV_ITEMS, PHONE_TAB_VIEWS } from "./routes";
import type { View } from "./types";

interface PhoneTabBarProps {
  currentView: View;
  onChangeView: (view: View) => void;
  /** Opens the full navigation drawer, for everything that is not a tab. */
  onOpenMenu: () => void;
  menuOpen: boolean;
  /** Items waiting on the owner; shown as a badge on Today. */
  needsYouCount: number;
}

const tabClass =
  "relative flex min-w-0 flex-1 flex-col items-center justify-center gap-1 text-[10.5px] font-medium transition-transform active:scale-[0.96]";

/** The phone layout's main navigation: the pages you check most, one thumb away. */
export default function PhoneTabBar({
  currentView,
  onChangeView,
  onOpenMenu,
  menuOpen,
  needsYouCount,
}: PhoneTabBarProps) {
  const { t } = useI18n();
  const tabs = PHONE_TAB_VIEWS.map((view) => NAV_ITEMS.find((item) => item.view === view)!);
  const onTab = tabs.some((tab) => tab.view === currentView);

  return (
    <nav
      aria-label={t({ en: "Main" })}
      className="fixed inset-x-0 bottom-0 z-30 flex backdrop-blur-md"
      style={{
        height: "calc(3.5rem + env(safe-area-inset-bottom, 0px))",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
        borderTop: "1px solid var(--th-border)",
        background: "var(--th-bg-header)",
      }}
    >
      {tabs.map(({ view, icon: Icon, label }) => {
        const active = currentView === view;
        const badge = view === "dashboard" ? needsYouCount : 0;
        return (
          <button
            key={view}
            type="button"
            onClick={() => onChangeView(view)}
            aria-current={active ? "page" : undefined}
            className={tabClass}
            style={{ color: active ? "var(--th-text-heading)" : "var(--th-text-muted)" }}
          >
            <span className="relative flex">
              <Icon size={20} strokeWidth={1.75} style={{ color: active ? "var(--ax-signal)" : undefined }} />
              {badge > 0 && (
                <span
                  className="absolute -right-3 -top-1.5 min-w-[16px] rounded-full px-1 text-center text-[10px] font-semibold tabular-nums leading-4"
                  style={{ background: "var(--ax-signal)", color: "var(--ax-signal-ink)" }}
                  aria-label={t({
                    en: `${badge} waiting`,
                  })}
                >
                  {badge > 99 ? "99+" : badge}
                </span>
              )}
            </span>
            <span className="max-w-full truncate px-1">{t(label)}</span>
          </button>
        );
      })}
      <button
        type="button"
        onClick={onOpenMenu}
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        className={tabClass}
        style={{ color: onTab ? "var(--th-text-muted)" : "var(--th-text-heading)" }}
      >
        <Menu size={20} strokeWidth={1.75} style={{ color: onTab ? undefined : "var(--ax-signal)" }} />
        <span>{t({ en: "Menu" })}</span>
      </button>
    </nav>
  );
}
