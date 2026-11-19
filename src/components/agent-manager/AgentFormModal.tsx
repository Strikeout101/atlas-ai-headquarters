import { Image as ImageIcon, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, Department } from "../../types";
import AgentAvatar from "../AgentAvatar";
import { localeName, useI18n } from "../../i18n";
import * as api from "../../api";
import { CLI_PROVIDERS, ROLE_BADGE, ROLE_LABEL, ROLES } from "./constants";
import EmojiPicker from "./EmojiPicker";
import type { FormData } from "./types";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Whether the agent thinks on its own and suggests tasks. Locked on for team leaders. */
export function AutonomyToggle({
  isLeader,
  checked,
  onChange,
}: {
  isLeader: boolean;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const { t } = useI18n();
  const label = t({ en: "Suggests tasks" });
  const help = isLeader
    ? t({
        en: "Team leaders always suggest tasks in their free time. Only the ones you approve become tasks.",
      })
    : t({
        en: "Thinks on its own in free time and suggests tasks. Only the ones you approve on Today become tasks.",
      });
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div id="agent-autonomy-label" className="text-xs font-medium" style={{ color: "var(--th-text-secondary)" }}>
          {label}
        </div>
        <p
          id="agent-autonomy-help"
          className="mt-0.5 text-[11px] leading-snug"
          style={{ color: "var(--th-text-muted)" }}
        >
          {help}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby="agent-autonomy-label"
        aria-describedby="agent-autonomy-help"
        disabled={isLeader}
        onClick={() => onChange(!checked)}
        className="relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60"
        style={{ background: checked ? "var(--ax-signal, #3b82f6)" : "var(--th-input-border)" }}
      >
        <span
          className="inline-block h-4 w-4 rounded-full bg-white shadow transition-transform"
          style={{ transform: checked ? "translateX(18px)" : "translateX(2px)" }}
        />
      </button>
    </div>
  );
}

export default function AgentFormModal({
  locale,
  tr,
  form,
  setForm,
  departments,
  isEdit,
  saving,
  onSave,
  onClose,
  agents = [],
  agentId = null,
}: {
  locale: string;
  tr: (en: string) => string;
  form: FormData;
  setForm: (f: FormData) => void;
  departments: Department[];
  isEdit: boolean;
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
  /** All agents, so the preview shows the same headshot the agent will get on its card. */
  agents?: Agent[];
  /** The agent being edited; null when hiring. */
  agentId?: string | null;
}) {
  const { t } = useI18n();
  const overlayRef = useRef<HTMLDivElement>(null);
  const [spriteFile, setSpriteFile] = useState<File | null>(null);
  const [processing, setProcessing] = useState(false);
  const [previews, setPreviews] = useState<Record<string, string> | null>(null);
  const [spriteNum, setSpriteNum] = useState(form.sprite_number ?? 0);
  const draftId = agentId ?? "__draft_agent__";
  const previewAgents = useMemo<Agent[]>(() => {
    const others = agents.filter((agent) => agent.id !== draftId);
    const base = agents.find((agent) => agent.id === draftId);
    const draft = { ...(base ?? ({ id: draftId, name: form.name } as Agent)), sprite_number: spriteNum };
    return [...others, draft];
  }, [agents, draftId, form.name, spriteNum]);
  const previewAgent = previewAgents[previewAgents.length - 1];
  const [registering, setRegistering] = useState(false);
  const [registered, setRegistered] = useState(false);

  // Close with Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const inputCls =
    "w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors";
  const inputStyle = {
    background: "var(--th-input-bg)",
    borderColor: "var(--th-input-border)",
    color: "var(--th-text-primary)",
  };

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "var(--th-modal-overlay)" }}
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto overscroll-contain rounded-2xl p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-200"
        style={{
          background: "var(--th-card-bg)",
          border: "1px solid var(--th-card-border)",
          backdropFilter: "blur(20px)",
        }}
      >
        {/* Modal header */}
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-base font-bold" style={{ color: "var(--th-text-heading)" }}>
            {isEdit ? tr("Edit Agent") : tr("Hire New Agent")}
          </h3>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-[var(--th-bg-surface-hover)] transition-colors"
            style={{ color: "var(--th-text-muted)" }}
          >
            ✕
          </button>
        </div>

        {/* 2-column layout */}
        <div className="grid grid-cols-2 gap-5">
          {/* ── Left column: basics ── */}
          <div className="space-y-4">
            <div className="text-[11.5px] font-semibold" style={{ color: "var(--th-text-muted)" }}>
              {tr("Basic Info")}
            </div>
            {/* ── Sprite face preview + up/down to change ── */}
            <div className="flex items-center gap-3">
              <div className="flex flex-col items-center gap-1">
                <button
                  type="button"
                  className="w-6 h-6 rounded flex items-center justify-center text-xs hover:bg-[var(--th-bg-surface-hover)] transition-colors"
                  style={{ color: "var(--th-text-muted)", border: "1px solid var(--th-input-border)" }}
                  onClick={() => {
                    const next = Math.max(1, spriteNum || 0) + 1;
                    setSpriteNum(next);
                    setForm({ ...form, sprite_number: next });
                  }}
                >
                  ▲
                </button>
                <div
                  className="w-14 h-14 rounded-xl overflow-hidden bg-gray-700 flex items-center justify-center flex-shrink-0"
                  style={{ border: "2px solid var(--th-input-border)" }}
                >
                  {spriteNum > 0 ? (
                    <AgentAvatar agent={previewAgent} agents={previewAgents} size={56} rounded="xl" />
                  ) : (
                    <span className="text-2xl">{form.avatar_emoji || "🤖"}</span>
                  )}
                </div>
                <button
                  type="button"
                  className="w-6 h-6 rounded flex items-center justify-center text-xs hover:bg-[var(--th-bg-surface-hover)] transition-colors"
                  style={{ color: "var(--th-text-muted)", border: "1px solid var(--th-input-border)" }}
                  onClick={() => {
                    const next = Math.max(1, (spriteNum || 1) - 1);
                    setSpriteNum(next);
                    setForm({ ...form, sprite_number: next });
                  }}
                >
                  ▼
                </button>
              </div>
              <div className="flex-1 min-w-0">
                <span
                  className="text-xs font-mono px-1.5 py-0.5 rounded"
                  style={{ color: "var(--th-text-muted)", background: "var(--th-bg-surface-hover)" }}
                >
                  #{spriteNum || "—"}
                </span>
                <div className="mt-2">
                  <label className="block text-xs mb-1.5 font-medium" style={{ color: "var(--th-text-secondary)" }}>
                    {tr("Name")} <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Marcus"
                    className={inputCls}
                    style={inputStyle}
                  />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-[72px_1fr] gap-2">
              <div>
                <label className="block text-xs mb-1.5 font-medium" style={{ color: "var(--th-text-secondary)" }}>
                  {tr("Emoji")}
                </label>
                <EmojiPicker
                  tr={tr}
                  value={form.avatar_emoji}
                  onChange={(emoji) => setForm({ ...form, avatar_emoji: emoji })}
                />
              </div>
              <div>
                <label className="block text-xs mb-1.5 font-medium" style={{ color: "var(--th-text-secondary)" }}>
                  {tr("Department")}
                </label>
                <select
                  disabled={form.role === "vp"}
                  value={form.department_id}
                  onChange={(e) => setForm({ ...form, department_id: e.target.value })}
                  className={`${inputCls} cursor-pointer`}
                  style={inputStyle}
                >
                  <option value="">{tr("— Unassigned —")}</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.icon} {localeName(locale, d)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* ── Right column: role ── */}
          <div className="space-y-4">
            <div className="text-[11.5px] font-semibold" style={{ color: "var(--th-text-muted)" }}>
              {tr("Role Config")}
            </div>
            {/* Rank */}
            <div>
              <label className="block text-xs mb-1.5 font-medium" style={{ color: "var(--th-text-secondary)" }}>
                {tr("Role")}
              </label>
              <div className="grid grid-cols-4 gap-1.5">
                {ROLES.map((r) => {
                  const active = form.role === r;
                  return (
                    <button
                      key={r}
                      disabled={form.role === "vp" || r === "vp"}
                      onClick={() => setForm({ ...form, role: r })}
                      className={`py-2 rounded-lg text-xs font-medium border transition-all ${
                        active ? ROLE_BADGE[r] : ""
                      }`}
                      style={
                        !active ? { borderColor: "var(--th-input-border)", color: "var(--th-text-muted)" } : undefined
                      }
                    >
                      {ROLE_LABEL[r].en}
                    </button>
                  );
                })}
              </div>
            </div>
            {/* CLI Provider */}
            <div>
              <label className="block text-xs mb-1.5 font-medium" style={{ color: "var(--th-text-secondary)" }}>
                {tr("CLI Provider")}
              </label>
              <div className="flex flex-wrap gap-1.5">
                {CLI_PROVIDERS.map((p) => {
                  const active = form.cli_provider === p;
                  return (
                    <button
                      key={p}
                      disabled={form.role === "vp"}
                      onClick={() => setForm({ ...form, cli_provider: p })}
                      className={`px-2.5 py-1.5 rounded-lg text-[11px] font-mono border transition-all ${
                        active ? "bg-blue-500/15 text-blue-400 border-blue-500/30" : ""
                      }`}
                      style={
                        !active ? { borderColor: "var(--th-input-border)", color: "var(--th-text-muted)" } : undefined
                      }
                    >
                      {p === "gemini" ? "Antigravity CLI / Gemini" : p === "antigravity" ? "Antigravity OAuth" : p}
                    </button>
                  );
                })}
              </div>
            </div>
            {form.cli_provider === "api" && (
              <label className="block text-xs space-y-1.5">
                <span>{tr("CLI fallback after approval")}</span>
                <select
                  value={form.cli_fallback_provider ?? "codex"}
                  onChange={(e) => setForm({ ...form, cli_fallback_provider: e.target.value as "codex" | "claude" })}
                  className={inputCls}
                  style={inputStyle}
                >
                  <option value="codex">Codex</option>
                  <option value="claude">Claude</option>
                </select>
              </label>
            )}
            {/* Personality / prompt */}
            <div>
              <label className="block text-xs mb-1.5 font-medium" style={{ color: "var(--th-text-secondary)" }}>
                {tr("Personality / Prompt")}
              </label>
              <textarea
                value={form.personality}
                onChange={(e) => setForm({ ...form, personality: e.target.value })}
                rows={3}
                placeholder={tr("Expertise or personality...")}
                className={`${inputCls} resize-none`}
                style={inputStyle}
              />
            </div>
            <AutonomyToggle
              isLeader={form.role === "team_leader"}
              checked={form.role === "team_leader" || form.autonomy_enabled}
              onChange={(next) => setForm({ ...form, autonomy_enabled: next })}
            />
          </div>
        </div>

        {/* ── Sprite Upload ── */}
        <div className="mt-5 pt-4" style={{ borderTop: "1px solid var(--th-card-border)" }}>
          <div className="text-[11.5px] font-semibold mb-3" style={{ color: "var(--th-text-muted)" }}>
            {tr("Character Sprite")}
          </div>

          {!previews && !processing && (
            <label
              className="flex flex-col items-center justify-center gap-2 py-6 rounded-xl border-2 border-dashed cursor-pointer transition-colors hover:border-blue-500/50"
              style={{ borderColor: "var(--th-input-border)", color: "var(--th-text-muted)" }}
            >
              <ImageIcon size={22} strokeWidth={1.5} />
              <span className="text-xs">{tr("Upload 4-direction sprite sheet (2x2 grid)")}</span>
              <span className="text-xs">{tr("Front / Left / Back / Right order")}</span>
              <span className="text-xs">
                {t({
                  en: "(White background)",
                })}
              </span>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setSpriteFile(file);
                  setProcessing(true);
                  setPreviews(null);
                  setRegistered(false);
                  try {
                    const base64 = await fileToBase64(file);
                    const result = await api.processSprite(base64);
                    setPreviews(result.previews);
                    setSpriteNum(result.suggestedNumber);
                  } catch (err) {
                    console.error("Sprite processing failed:", err);
                  } finally {
                    setProcessing(false);
                  }
                }}
              />
            </label>
          )}

          {processing && (
            <div className="flex items-center justify-center gap-2 py-8" style={{ color: "var(--th-text-muted)" }}>
              <Loader2 size={18} className="animate-spin" />
              <span className="text-sm">{tr("Removing background & splitting...")}</span>
            </div>
          )}

          {previews && !processing && (
            <div className="space-y-3">
              {/* Preview grid */}
              <div className="grid grid-cols-3 gap-3">
                {(["D", "L", "R"] as const).map((dir) => (
                  <div key={dir} className="text-center">
                    <div className="text-[10px] font-medium mb-1" style={{ color: "var(--th-text-muted)" }}>
                      {dir === "D" ? tr("Front") : dir === "L" ? tr("Left") : tr("Right")}
                    </div>
                    <div
                      className="rounded-lg p-2 flex items-center justify-center h-24"
                      style={{ background: "var(--th-input-bg)", border: "1px solid var(--th-input-border)" }}
                    >
                      {previews[dir] ? (
                        <img
                          src={previews[dir]}
                          alt={dir}
                          className="max-h-20 object-contain"
                          style={{ imageRendering: "pixelated" }}
                        />
                      ) : (
                        <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                          —
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Sprite number + register */}
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <label className="text-xs font-medium" style={{ color: "var(--th-text-secondary)" }}>
                    {tr("Sprite #")}
                  </label>
                  <input
                    type="number"
                    value={spriteNum}
                    onChange={(e) => setSpriteNum(Number(e.target.value))}
                    min={1}
                    className="w-16 px-2 py-1 border rounded-lg text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                    style={{
                      background: "var(--th-input-bg)",
                      borderColor: "var(--th-input-border)",
                      color: "var(--th-text-primary)",
                    }}
                  />
                </div>
                <button
                  onClick={async () => {
                    if (!previews) return;
                    setRegistering(true);
                    try {
                      await api.registerSprite(previews, spriteNum);
                      setRegistered(true);
                      setForm({ ...form, sprite_number: spriteNum });
                    } catch (err) {
                      console.error("Sprite register failed:", err);
                    } finally {
                      setRegistering(false);
                    }
                  }}
                  disabled={registering || registered || !spriteNum}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    registered
                      ? "bg-emerald-600/20 text-emerald-400 border border-emerald-500/30"
                      : "bg-blue-600 hover:bg-blue-500 text-white"
                  } disabled:opacity-50`}
                >
                  {registering ? tr("Registering...") : registered ? tr("Registered!") : tr("Register Sprite")}
                </button>
                {previews && (
                  <button
                    onClick={() => {
                      setPreviews(null);
                      setSpriteFile(null);
                      setRegistered(false);
                    }}
                    className="text-xs px-2 py-1 rounded-lg hover:bg-[var(--th-bg-surface-hover)] transition-colors"
                    style={{ color: "var(--th-text-muted)" }}
                  >
                    {tr("Re-upload")}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Actions — full width */}
        <div className="flex gap-2 mt-5 pt-4" style={{ borderTop: "1px solid var(--th-card-border)" }}>
          <button
            onClick={onSave}
            disabled={saving || !form.name.trim()}
            className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ax-btn-primary disabled:opacity-40 shadow-sm"
          >
            {saving ? tr("Saving...") : isEdit ? tr("Save Changes") : tr("Confirm Hire")}
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2.5 rounded-lg text-sm font-medium transition-all hover:bg-[var(--th-bg-surface-hover)]"
            style={{ border: "1px solid var(--th-input-border)", color: "var(--th-text-secondary)" }}
          >
            {tr("Cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
