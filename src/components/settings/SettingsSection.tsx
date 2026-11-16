import { useState, type ReactNode } from "react";

interface SettingsSectionProps {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  actions?: ReactNode;
  className?: string;
}

/** Shared disclosure: collapsed forms stay mounted so unsaved changes are retained. */
export default function SettingsSection({
  title,
  description,
  children,
  defaultOpen = false,
  actions,
  className = "",
}: SettingsSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className={`min-w-0 rounded-xl border ${className}`}
      style={{ background: "var(--th-card-bg)", borderColor: "var(--th-card-border)" }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-xl px-5 py-4 outline-none transition hover:bg-slate-500/5 focus-visible:ring-2 focus-visible:ring-[var(--th-focus-ring-shadow)] sm:px-6 [&::-webkit-details-marker]:hidden">
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          className="shrink-0 transition-transform"
          style={{ transform: open ? "rotate(90deg)" : undefined }}
        >
          <path d="m9 5 7 7-7 7" />
        </svg>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold" style={{ color: "var(--th-text-heading)" }}>
            {title}
          </span>
          {description && (
            <span className="mt-1 block text-xs leading-relaxed" style={{ color: "var(--th-text-secondary)" }}>
              {description}
            </span>
          )}
        </span>
      </summary>
      <div className="min-w-0 space-y-5 border-t px-5 py-5 sm:px-6" style={{ borderColor: "var(--th-card-border)" }}>
        {actions && <div className="flex flex-wrap justify-end gap-2">{actions}</div>}
        {children}
      </div>
    </details>
  );
}
