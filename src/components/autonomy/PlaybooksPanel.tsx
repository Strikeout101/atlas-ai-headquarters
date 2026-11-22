import { useState } from "react";
import {
  addPlaybookResearchSchedule,
  resetPlaybook,
  savePlaybook,
  type Playbook,
  type PlaybookStep,
} from "../../api/autonomy";
import type { Department, Project } from "../../types";

const inputClass = "w-full rounded-lg border px-3 py-2 text-sm";
const inputStyle = {
  background: "var(--th-input-bg)",
  borderColor: "var(--th-input-border)",
  color: "var(--th-text-primary)",
};

function StepEditor({
  step,
  departments,
  onChange,
  label,
}: {
  step: PlaybookStep;
  departments: Department[];
  onChange: (step: PlaybookStep) => void;
  label: string;
}) {
  return (
    <fieldset className="space-y-2 rounded-lg border p-3" style={{ borderColor: "var(--th-border)" }}>
      <legend className="px-1 text-xs font-semibold">{label}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs">
          Task title ({"{title}"} is the initiative)
          <input
            className={inputClass}
            style={inputStyle}
            value={step.title}
            onChange={(e) => onChange({ ...step, title: e.target.value })}
          />
        </label>
        <label className="text-xs">
          Department
          <select
            className={inputClass}
            style={inputStyle}
            value={step.department_id}
            onChange={(e) => onChange({ ...step, department_id: e.target.value })}
          >
            {departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
            {!departments.some((d) => d.id === step.department_id) && (
              <option value={step.department_id}>{step.department_id}</option>
            )}
          </select>
        </label>
      </div>
      <label className="block text-xs">
        Instructions ({"{title}"}, {"{description}"}, {"{initiative_id}"} and {"{slug}"} are filled in)
        <textarea
          className={inputClass}
          style={inputStyle}
          rows={6}
          value={step.instructions}
          onChange={(e) => onChange({ ...step, instructions: e.target.value })}
        />
      </label>
    </fieldset>
  );
}

/**
 * Playbooks: the steps an income stream repeats. The research step runs as a schedule (created switched off);
 * each later step is queued for an initiative when the one before it finishes, through the usual approvals.
 */
export default function PlaybooksPanel({
  playbooks,
  departments,
  projects,
  busy,
  mutate,
}: {
  playbooks: Playbook[];
  departments: Department[];
  projects: Project[];
  busy: boolean;
  mutate: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, Playbook>>({});
  const [scheduleProject, setScheduleProject] = useState<Record<string, string>>({});
  return (
    <div className="mt-4 space-y-6">
      {playbooks.map((saved) => {
        const playbook = drafts[saved.key] ?? saved;
        const update = (next: Playbook) => setDrafts((current) => ({ ...current, [saved.key]: next }));
        const ventureProjects = projects.filter(
          (project) =>
            !("business" in project) || (project as Project & { business?: string }).business === playbook.business,
        );
        return (
          <section key={saved.key} aria-label={`Playbook ${playbook.title}`} className="space-y-3">
            <h3 className="text-sm font-semibold">{playbook.title}</h3>
            <StepEditor
              label="Research (runs as a schedule)"
              step={playbook.research}
              departments={departments}
              onChange={(research) => update({ ...playbook, research })}
            />
            {playbook.steps.map((step, index) => (
              <StepEditor
                key={step.key}
                label={`Step ${index + 1}: ${step.key}`}
                step={step}
                departments={departments}
                onChange={(next) =>
                  update({ ...playbook, steps: playbook.steps.map((s, i) => (i === index ? next : s)) })
                }
              />
            ))}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="ax-btn-primary"
                disabled={busy || !drafts[saved.key]}
                onClick={() =>
                  void mutate(async () => {
                    await savePlaybook(saved.key, { research: playbook.research, steps: playbook.steps });
                    setDrafts((current) => {
                      const next = { ...current };
                      delete next[saved.key];
                      return next;
                    });
                  })
                }
              >
                Save playbook
              </button>
              <button
                type="button"
                className="ax-btn-secondary"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm("Put this playbook back to the original steps?")) return;
                  void mutate(async () => {
                    await resetPlaybook(saved.key);
                    setDrafts((current) => {
                      const next = { ...current };
                      delete next[saved.key];
                      return next;
                    });
                  });
                }}
              >
                Reset to default
              </button>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs">
                Project for the research schedule
                <select
                  className={inputClass}
                  style={inputStyle}
                  value={scheduleProject[saved.key] ?? ""}
                  onChange={(e) => setScheduleProject((current) => ({ ...current, [saved.key]: e.target.value }))}
                >
                  <option value="">Choose a project</option>
                  {(ventureProjects.length ? ventureProjects : projects).map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="ax-btn-secondary"
                disabled={busy || !scheduleProject[saved.key]}
                onClick={() => void mutate(() => addPlaybookResearchSchedule(saved.key, scheduleProject[saved.key]))}
              >
                Add weekly research schedule (off)
              </button>
            </div>
          </section>
        );
      })}
    </div>
  );
}
