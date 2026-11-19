import { useState, type FormEvent } from "react";
import { addMilestone, deleteMilestone, setMilestoneDone, type GoalMilestone } from "../../api/autonomy";

const inputClass = "min-h-[36px] rounded-lg border px-2 py-1 text-sm";
const inputStyle = {
  background: "var(--th-input-bg)",
  borderColor: "var(--th-input-border)",
  color: "var(--th-text-primary)",
};

/**
 * Milestones under one goal. "When progress reaches" milestones complete only from the goal's verified measurement;
 * "I confirm it" milestones complete only when the owner ticks them. Tasks can never complete either.
 */
export default function GoalMilestones({
  goalId,
  milestones,
  busy,
  mutate,
}: {
  goalId: string;
  milestones: GoalMilestone[];
  busy: boolean;
  mutate: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<"progress" | "manual">("progress");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const title = String(values.get("title"));
    const target = Number(values.get("target"));
    void mutate(() => addMilestone(goalId, kind === "progress" ? { title, kind, target } : { title, kind }));
    setAdding(false);
  };
  return (
    <div className="mt-2 space-y-1">
      {milestones.length > 0 && (
        <ul className="space-y-1 text-xs" aria-label="Milestones">
          {milestones.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-2">
              {m.kind === "manual" ? (
                <input
                  type="checkbox"
                  aria-label={`Confirm ${m.title}`}
                  checked={m.status === "done"}
                  disabled={busy}
                  onChange={(e) => void mutate(() => setMilestoneDone(m.id, e.target.checked))}
                />
              ) : (
                <span aria-hidden>{m.status === "done" ? "✓" : "○"}</span>
              )}
              <span className={m.status === "done" ? "line-through opacity-70" : ""}>{m.title}</span>
              <span style={{ color: "var(--th-text-muted)" }}>
                {m.kind === "progress" ? `when progress reaches ${m.target}` : "you confirm"}
                {m.done_by === "verified" ? " · reached (verified)" : ""}
              </span>
              <button
                type="button"
                className="underline"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`Remove milestone "${m.title}"?`)) void mutate(() => deleteMilestone(m.id));
                }}
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <form aria-label="Add milestone" className="flex flex-wrap items-end gap-2" onSubmit={submit}>
          <input
            name="title"
            required
            minLength={2}
            maxLength={200}
            placeholder="First sale"
            aria-label="Milestone"
            className={inputClass}
            style={inputStyle}
          />
          <select
            aria-label="Completes"
            value={kind}
            onChange={(e) => setKind(e.target.value as "progress" | "manual")}
            className={inputClass}
            style={inputStyle}
          >
            <option value="progress">When progress reaches</option>
            <option value="manual">When I confirm it</option>
          </select>
          {kind === "progress" && (
            <input
              name="target"
              type="number"
              required
              min={0}
              step="any"
              aria-label="Target"
              placeholder="Target"
              className={`${inputClass} w-24`}
              style={inputStyle}
            />
          )}
          <button type="submit" className="ax-btn-secondary" disabled={busy}>
            Add
          </button>
          <button type="button" className="ax-btn-secondary" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <button type="button" className="text-xs underline" onClick={() => setAdding(true)}>
          Add a milestone
        </button>
      )}
    </div>
  );
}
