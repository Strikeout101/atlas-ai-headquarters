import type { GitHubBranch, GitHubRepo } from "../../api";
import { useI18n } from "../../i18n";
import type { WizardStep } from "./model";

interface GitHubImportWizardProps {
  step: WizardStep;
  selectedRepo: GitHubRepo | null;
  selectedBranch: string | null;
  repoSearch: string;
  repos: GitHubRepo[];
  reposLoading: boolean;
  directInput: string;
  directInputError: string | null;
  branchError: string | null;
  patToken: string;
  patLoading: boolean;
  branches: GitHubBranch[];
  branchesLoading: boolean;
  targetPath: string;
  projectName: string;
  coreGoal: string;
  cloneProgress: number;
  cloneStatus: string;
  cloneError: string | null;
  creating: boolean;
  onCancel: () => void;
  onResetToRepo: () => void;
  onGoToBranch: () => void;
  onGoToClone: () => void;
  onRepoSearchChange: (value: string) => void;
  onDirectInputChange: (value: string) => void;
  onDirectInputSubmit: () => void;
  onRepoSelect: (repo: GitHubRepo) => void;
  onPatTokenChange: (value: string) => void;
  onPatRetry: () => void;
  onBranchSelect: (branchName: string) => void;
  onProjectNameChange: (value: string) => void;
  onTargetPathChange: (value: string) => void;
  onCoreGoalChange: (value: string) => void;
  onImport: () => void;
  onBackToBranch: () => void;
}

export default function GitHubImportWizard({
  step,
  selectedRepo,
  selectedBranch,
  repoSearch,
  repos,
  reposLoading,
  directInput,
  directInputError,
  branchError,
  patToken,
  patLoading,
  branches,
  branchesLoading,
  targetPath,
  projectName,
  coreGoal,
  cloneProgress,
  cloneStatus,
  cloneError,
  creating,
  onCancel,
  onResetToRepo,
  onGoToBranch,
  onGoToClone,
  onRepoSearchChange,
  onDirectInputChange,
  onDirectInputSubmit,
  onRepoSelect,
  onPatTokenChange,
  onPatRetry,
  onBranchSelect,
  onProjectNameChange,
  onTargetPathChange,
  onCoreGoalChange,
  onImport,
  onBackToBranch,
}: GitHubImportWizardProps) {
  const { t } = useI18n();

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-slate-700 px-5 py-3">
        <button
          type="button"
          onClick={onResetToRepo}
          className={`rounded-full px-3 py-1 text-xs font-medium ${step === "repo" ? "bg-blue-600 text-white" : "bg-slate-700 text-slate-300 hover:bg-slate-600"}`}
        >
          1. {t({ en: "Select Repo" })}
        </button>
        <span className="text-slate-600">/</span>
        <button
          type="button"
          disabled={!selectedRepo}
          onClick={onGoToBranch}
          className={`rounded-full px-3 py-1 text-xs font-medium ${step === "branch" ? "bg-blue-600 text-white" : "bg-slate-700 text-slate-300 hover:bg-slate-600"} disabled:opacity-40`}
        >
          2. {t({ en: "Branch" })}
        </button>
        <span className="text-slate-600">/</span>
        <button
          type="button"
          disabled={!selectedBranch}
          onClick={onGoToClone}
          className={`rounded-full px-3 py-1 text-xs font-medium ${step === "clone" ? "bg-blue-600 text-white" : "bg-slate-700 text-slate-300 hover:bg-slate-600"} disabled:opacity-40`}
        >
          3. {t({ en: "Import" })}
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-400 hover:text-white"
        >
          {t({ en: "Cancel" })}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {step === "repo" && (
          <div className="space-y-3">
            <div className="space-y-2 rounded-xl border border-slate-600/50 bg-slate-800/40 p-3">
              <p className="text-xs font-medium text-slate-300">
                {t({
                  en: "Direct Input (incl. private repos)",
                })}
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder={t({
                    en: "owner/repo or GitHub URL",
                  })}
                  value={directInput}
                  onChange={(event) => onDirectInputChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") onDirectInputSubmit();
                  }}
                  className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
                />
                <button
                  type="button"
                  onClick={onDirectInputSubmit}
                  disabled={!directInput.trim()}
                  className="shrink-0 rounded-lg ax-btn-primary px-4 py-2 text-xs font-medium disabled:opacity-40"
                >
                  {t({ en: "Go" })}
                </button>
              </div>
              {directInputError && <p className="text-[11px] text-rose-300">{directInputError}</p>}
            </div>

            <div className="flex items-center gap-3">
              <div className="flex-1 border-t border-slate-700" />
              <span className="text-[11px] text-slate-500">
                {t({
                  en: "or select from list",
                })}
              </span>
              <div className="flex-1 border-t border-slate-700" />
            </div>

            <input
              type="text"
              placeholder={t({
                en: "Search repositories...",
              })}
              value={repoSearch}
              onChange={(event) => onRepoSearchChange(event.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
            />
            {reposLoading ? (
              <p className="text-xs text-slate-400">{t({ en: "Loading..." })}</p>
            ) : repos.length === 0 ? (
              <p className="text-xs text-slate-500">{t({ en: "No results" })}</p>
            ) : (
              <div className="space-y-1">
                {repos.map((repo) => (
                  <button
                    key={repo.id}
                    type="button"
                    onClick={() => onRepoSelect(repo)}
                    className="w-full rounded-lg border border-slate-700/70 bg-slate-800/60 px-4 py-3 text-left transition hover:border-blue-500/70 hover:bg-slate-800"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-white">{repo.full_name}</span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${repo.private ? "bg-amber-600/20 text-amber-300" : "bg-emerald-600/20 text-emerald-300"}`}
                      >
                        {repo.private ? "Private" : "Public"}
                      </span>
                    </div>
                    {repo.description && <p className="mt-1 truncate text-xs text-slate-400">{repo.description}</p>}
                    <p className="mt-1 text-[11px] text-slate-500">
                      {t({ en: "Default" })}: {repo.default_branch} · {new Date(repo.updated_at).toLocaleDateString()}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {step === "branch" && selectedRepo && (
          <div className="space-y-3">
            <div className="rounded-lg border border-slate-700 bg-slate-800/40 px-4 py-2">
              <p className="text-sm font-medium text-white">{selectedRepo.full_name}</p>
              {selectedRepo.description && <p className="text-xs text-slate-400">{selectedRepo.description}</p>}
            </div>
            <h4 className="text-xs font-semibold text-slate-300">{t({ en: "Select Branch" })}</h4>
            {branchError && (
              <div className="space-y-3">
                <div className="rounded-lg border border-rose-500/60 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                  {branchError}
                </div>
                <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-900/10 p-3">
                  <p className="text-xs font-medium text-amber-300">
                    {t({
                      en: "Authenticate with Personal Access Token (PAT)",
                    })}
                  </p>
                  <p className="text-[11px] text-slate-400">
                    {t({
                      en: "Go to GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens and create a token with access to this repo.",
                    })}
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      placeholder="ghp_xxxx... or github_pat_xxxx..."
                      value={patToken}
                      onChange={(event) => onPatTokenChange(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && patToken.trim()) onPatRetry();
                      }}
                      className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-amber-500"
                    />
                    <button
                      type="button"
                      onClick={onPatRetry}
                      disabled={!patToken.trim() || patLoading}
                      className="shrink-0 rounded-lg bg-amber-600 px-4 py-2 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-40"
                    >
                      {patLoading ? t({ en: "Verifying..." }) : t({ en: "Authenticate" })}
                    </button>
                  </div>
                </div>
              </div>
            )}
            {branchesLoading ? (
              <p className="text-xs text-slate-400">{t({ en: "Loading..." })}</p>
            ) : branches.length === 0 && !branchError ? (
              <p className="text-xs text-slate-500">{t({ en: "No branches" })}</p>
            ) : (
              <div className="space-y-1">
                {branches.map((branch) => (
                  <button
                    key={branch.name}
                    type="button"
                    onClick={() => onBranchSelect(branch.name)}
                    className={`w-full rounded-lg border px-4 py-2.5 text-left transition ${
                      branch.is_default
                        ? "border-blue-500/50 bg-blue-900/20 hover:bg-blue-900/30"
                        : "border-slate-700/70 bg-slate-800/60 hover:border-blue-500/70 hover:bg-slate-800"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-white">{branch.name}</span>
                      {branch.is_default && (
                        <span className="rounded bg-blue-600/30 px-1.5 py-0.5 text-[10px] font-medium text-blue-300">
                          default
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-500">{branch.sha?.slice(0, 8)}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {step === "clone" && selectedRepo && selectedBranch && (
          <div className="space-y-4">
            <div className="rounded-lg border border-slate-700 bg-slate-800/40 px-4 py-2">
              <p className="text-sm text-white">
                {selectedRepo.full_name} <span className="text-blue-400">({selectedBranch})</span>
              </p>
            </div>

            <label className="block text-xs text-slate-400">
              {t({ en: "Project Name" })}
              <input
                type="text"
                value={projectName}
                onChange={(event) => onProjectNameChange(event.target.value)}
                disabled={creating}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500 disabled:opacity-50"
              />
            </label>

            <label className="block text-xs text-slate-400">
              {t({ en: "Target Path" })}
              <input
                type="text"
                value={targetPath}
                onChange={(event) => onTargetPathChange(event.target.value)}
                disabled={creating}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500 disabled:opacity-50"
              />
            </label>

            <label className="block text-xs text-slate-400">
              {t({
                en: "Core Goal (optional)",
              })}
              <textarea
                rows={3}
                value={coreGoal}
                onChange={(event) => onCoreGoalChange(event.target.value)}
                disabled={creating}
                className="mt-1 w-full resize-none rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500 disabled:opacity-50"
              />
            </label>

            {(cloneStatus === "cloning" || cloneStatus === "done") && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-400">
                    {cloneStatus === "done" ? t({ en: "Complete" }) : t({ en: "Cloning..." })}
                  </span>
                  <span className="text-slate-400">{cloneProgress}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-slate-700">
                  <div
                    className="h-full rounded-full bg-blue-500 transition-all duration-300"
                    style={{ width: `${cloneProgress}%` }}
                  />
                </div>
              </div>
            )}

            {cloneError && (
              <div className="rounded-lg border border-rose-500/60 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                {cloneError}
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={onImport}
                disabled={creating || !projectName.trim() || !targetPath.trim()}
                className="rounded-lg ax-btn-primary px-4 py-2 text-sm font-medium disabled:opacity-40"
              >
                {creating
                  ? t({ en: "Importing..." })
                  : t({
                      en: "Import from GitHub",
                    })}
              </button>
              <button
                type="button"
                onClick={onBackToBranch}
                disabled={creating}
                className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 disabled:opacity-40"
              >
                {t({ en: "Back" })}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
