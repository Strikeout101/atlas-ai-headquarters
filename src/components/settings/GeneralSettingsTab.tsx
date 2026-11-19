import type { CliProvider } from "../../types";
import type { LocalSettings, SetLocalSettings, TFunction } from "./types";
import SettingsSection from "./SettingsSection";
import ServiceAndBackups from "./ServiceAndBackups";

interface GeneralSettingsTabProps {
  t: TFunction;
  form: LocalSettings;
  setForm: SetLocalSettings;
  saved: boolean;
  onSave: () => void;
}

interface ToggleSettingCardProps {
  label: string;
  checked: boolean;
  onToggle: () => void;
  title?: string;
}

function ToggleSettingCard({ label, checked, onToggle, title }: ToggleSettingCardProps) {
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 sm:px-4"
      style={{ borderColor: "var(--th-card-border)", background: "var(--th-input-bg)" }}
    >
      <label className="text-sm" style={{ color: "var(--th-text-secondary)" }}>
        {label}
      </label>
      <button
        type="button"
        aria-pressed={checked}
        aria-label={label}
        onClick={onToggle}
        className={`relative h-6 w-11 rounded-full transition-colors ${checked ? "bg-blue-500" : "bg-slate-600"}`}
        title={title}
      >
        <div
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all ${
            checked ? "left-[22px]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}

export default function GeneralSettingsTab({ t, form, setForm, saved, onSave }: GeneralSettingsTabProps) {
  return (
    <>
      <SettingsSection title={t({ en: "Company and preferences" })} defaultOpen>
        <div>
          <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
            {t({ en: "Company Name" })}
          </label>
          <input
            type="text"
            value={form.companyName}
            onChange={(e) => setForm({ ...form, companyName: e.target.value })}
            className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
            style={{
              background: "var(--th-input-bg)",
              borderColor: "var(--th-input-border)",
              color: "var(--th-text-primary)",
            }}
          />
        </div>

        <div>
          <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
            {t({ en: "CEO Name" })}
          </label>
          <input
            type="text"
            value={form.ceoName}
            onChange={(e) => setForm({ ...form, ceoName: e.target.value })}
            className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
            style={{
              background: "var(--th-input-bg)",
              borderColor: "var(--th-input-border)",
              color: "var(--th-text-primary)",
            }}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <ToggleSettingCard
            label={t({ en: "Auto Assign" })}
            checked={form.autoAssign}
            onToggle={() => setForm({ ...form, autoAssign: !form.autoAssign })}
          />

          <ToggleSettingCard
            label={t({ en: "YOLO Mode" })}
            checked={form.yoloMode === true}
            onToggle={() => setForm({ ...form, yoloMode: !(form.yoloMode === true) })}
            title={t({
              en: "When enabled, the planning lead auto-analyzes decision steps and proceeds automatically.",
            })}
          />

          {/* Upstream auto-update is locked in ATLAS; updates come from the Service section below. */}
          <ToggleSettingCard
            label={t({ en: "OAuth Auto Swap" })}
            checked={form.oauthAutoSwap !== false}
            onToggle={() => setForm({ ...form, oauthAutoSwap: !(form.oauthAutoSwap !== false) })}
            title={t({
              en: "Auto-switch to next OAuth account on failures/limits",
            })}
          />
        </div>

        <div>
          <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
            {t({
              en: "Default CLI Provider",
            })}
          </label>
          <select
            value={form.defaultProvider}
            onChange={(e) => setForm({ ...form, defaultProvider: e.target.value as CliProvider })}
            className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
            style={{
              background: "var(--th-input-bg)",
              borderColor: "var(--th-input-border)",
              color: "var(--th-text-primary)",
            }}
          >
            <option value="claude">Claude Code</option>
            <option value="codex">Codex CLI</option>
            <option value="gemini">Antigravity CLI / Gemini CLI</option>
            <option value="opencode">OpenCode</option>
          </select>
        </div>
      </SettingsSection>

      <div className="flex justify-end gap-3">
        {saved && <span className="text-green-400 text-sm self-center">✅ {t({ en: "Saved" })}</span>}
        <button
          onClick={onSave}
          className="px-8 py-2.5 ax-btn-primary text-sm font-semibold rounded-xl transition-all shadow-lg hover:shadow-blue-500/30"
        >
          {t({ en: "Save" })}
        </button>
      </div>

      <ServiceAndBackups />
    </>
  );
}
