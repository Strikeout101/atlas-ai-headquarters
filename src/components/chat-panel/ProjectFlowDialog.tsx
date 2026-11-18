import type { Project } from "../../types";

type ProjectFlowStep = "choose" | "existing" | "new" | "confirm";

type Tr = (en: string) => string;

interface ProjectFlowDialogProps {
  open: boolean;
  step: ProjectFlowStep;
  isDirectivePending: boolean;
  pendingContent: string;
  projectLoading: boolean;
  projectItems: Project[];
  selectedProject: Project | null;
  existingProjectInput: string;
  existingProjectError: string;
  newProjectName: string;
  newProjectPath: string;
  newProjectGoal: string;
  projectSaving: boolean;
  canCreateProject: boolean;
  tr: Tr;
  onClose: () => void;
  onChooseExisting: () => void;
  onChooseNew: () => void;
  onBackToChoose: () => void;
  onSelectExistingProject: (project: Project, index: number) => void;
  onExistingProjectInputChange: (value: string) => void;
  onApplyExistingProjectSelection: () => void;
  onNewProjectNameChange: (value: string) => void;
  onNewProjectPathChange: (value: string) => void;
  onNewProjectGoalChange: (value: string) => void;
  onCreateProject: () => void;
  onConfirm: () => void;
}

export default function ProjectFlowDialog({
  open,
  step,
  isDirectivePending,
  pendingContent,
  projectLoading,
  projectItems,
  selectedProject,
  existingProjectInput,
  existingProjectError,
  newProjectName,
  newProjectPath,
  newProjectGoal,
  projectSaving,
  canCreateProject,
  tr,
  onClose,
  onChooseExisting,
  onChooseNew,
  onBackToChoose,
  onSelectExistingProject,
  onExistingProjectInputChange,
  onApplyExistingProjectSelection,
  onNewProjectNameChange,
  onNewProjectPathChange,
  onNewProjectGoalChange,
  onCreateProject,
  onConfirm,
}: ProjectFlowDialogProps) {
  if (!open) return null;

  return (
    <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/75 p-4">
      <div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
          <h3 className="text-sm font-semibold text-white">{tr("Project Branch")}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            ✕
          </button>
        </div>

        <div className="space-y-3 px-4 py-4 text-sm">
          {step === "choose" && (
            <>
              <p className="text-slate-200">{tr("Is this an existing project or a new project?")}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={onChooseExisting}
                  className="flex-1 rounded-lg ax-btn-primary px-3 py-2 text-xs font-medium"
                >
                  {tr("Existing Project")}
                </button>
                <button
                  type="button"
                  onClick={onChooseNew}
                  className="flex-1 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-500"
                >
                  {tr("New Project")}
                </button>
              </div>
            </>
          )}

          {step === "existing" && (
            <>
              <p className="text-xs text-slate-400">
                {tr("Showing 10 recent projects. Enter a number (1-10) or project name.")}
              </p>
              {projectLoading ? (
                <p className="text-xs text-slate-500">{tr("Loading...")}</p>
              ) : projectItems.length === 0 ? (
                <p className="text-xs text-slate-500">{tr("No projects")}</p>
              ) : (
                <div className="max-h-52 space-y-2 overflow-y-auto pr-1">
                  {projectItems.map((project, idx) => (
                    <div key={project.id} className="rounded-lg border border-slate-700 bg-slate-800/60 p-2">
                      <p className="text-xs font-medium text-slate-100">
                        <span className="mr-1 text-blue-300">{idx + 1}.</span>
                        {project.name}
                      </p>
                      <p className="truncate text-[11px] text-slate-400">{project.project_path}</p>
                      <button
                        type="button"
                        onClick={() => onSelectExistingProject(project, idx)}
                        className="mt-2 rounded bg-blue-700 px-2 py-1 text-[11px] text-white hover:bg-blue-600"
                      >
                        {tr("Select")}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="space-y-2 pt-1">
                <input
                  type="text"
                  value={existingProjectInput}
                  onChange={(e) => onExistingProjectInputChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      onApplyExistingProjectSelection();
                    }
                  }}
                  placeholder={tr("e.g. 1 or project name")}
                  className="w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-blue-500"
                />
                {existingProjectError && <p className="text-[11px] text-rose-300">{existingProjectError}</p>}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={onApplyExistingProjectSelection}
                    className="flex-1 rounded bg-blue-700 px-2 py-1.5 text-[11px] text-white hover:bg-blue-600"
                  >
                    {tr("Select from input")}
                  </button>
                  <button
                    type="button"
                    onClick={onBackToChoose}
                    className="rounded border border-slate-700 px-2 py-1.5 text-[11px] text-slate-300"
                  >
                    {tr("Back")}
                  </button>
                </div>
              </div>
            </>
          )}

          {step === "new" && (
            <>
              <input
                type="text"
                value={newProjectName}
                onChange={(e) => onNewProjectNameChange(e.target.value)}
                placeholder={tr("Project name")}
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white outline-none focus:border-blue-500"
              />
              <input
                type="text"
                value={newProjectPath}
                onChange={(e) => onNewProjectPathChange(e.target.value)}
                placeholder={tr("Project path")}
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white outline-none focus:border-blue-500"
              />
              <textarea
                rows={3}
                value={newProjectGoal}
                onChange={(e) => onNewProjectGoalChange(e.target.value)}
                readOnly={isDirectivePending}
                placeholder={tr("Core goal")}
                className="w-full resize-none rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white outline-none focus:border-blue-500"
              />
              {isDirectivePending && (
                <p className="text-[11px] text-slate-400">
                  {tr("The $ directive text is automatically used as the new project core goal.")}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={onCreateProject}
                  disabled={!canCreateProject || projectSaving}
                  className="flex-1 rounded bg-emerald-700 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-40"
                >
                  {projectSaving ? tr("Creating...") : tr("Create & Select")}
                </button>
                <button
                  type="button"
                  onClick={onBackToChoose}
                  className="rounded border border-slate-700 px-3 py-2 text-xs text-slate-300"
                >
                  {tr("Back")}
                </button>
              </div>
            </>
          )}

          {step === "confirm" && selectedProject && (
            <>
              <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
                <p className="text-xs font-semibold text-white">{selectedProject.name}</p>
                <p className="mt-1 text-[11px] text-slate-400">{selectedProject.project_path}</p>
                <p className="mt-1 text-[11px] text-slate-300">{selectedProject.core_goal}</p>
                {selectedProject.assignment_mode === "manual" && (
                  <div className="mt-2 flex items-center gap-1.5 text-[11px] text-violet-300">
                    <span className="inline-block h-2 w-2 rounded-full bg-violet-400"></span>
                    {tr(
                      `Manual mode — ${selectedProject.assigned_agent_ids?.length ?? 0} assigned agents will work on this`,
                    )}
                  </div>
                )}
              </div>
              <div className="rounded-lg border border-blue-700/40 bg-blue-900/20 p-3 text-[11px] text-blue-100">
                <p className="font-medium">{tr("Round Goal")}</p>
                <p className="mt-1 leading-relaxed">
                  {tr(
                    `Execute this round with project core goal (${selectedProject.core_goal}) and current request (${pendingContent}).`,
                  )}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={onConfirm}
                  className="flex-1 rounded ax-btn-primary px-3 py-2 text-xs font-medium"
                >
                  {tr("Select & Send")}
                </button>
                <button
                  type="button"
                  onClick={onBackToChoose}
                  className="rounded border border-slate-700 px-3 py-2 text-xs text-slate-300"
                >
                  {tr("Re-select")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
