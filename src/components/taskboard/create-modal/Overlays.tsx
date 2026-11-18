import { timeAgo } from "../constants";
import type { CreateTaskModalOverlaysProps } from "./overlay-types";

export default function CreateTaskModalOverlays({
  t,
  localeTag,
  restorePromptOpen,
  selectedRestoreDraft,
  restoreCandidates,
  selectedRestoreDraftId,
  formatDraftTimestamp,
  submitWithoutProjectPromptOpen,
  missingPathPrompt,
  submitBusy,
  manualPathPickerOpen,
  manualPathLoading,
  manualPathCurrent,
  manualPathParent,
  manualPathEntries,
  manualPathTruncated,
  manualPathError,
  draftModalOpen,
  drafts,
  onSelectRestoreDraft,
  onCloseRestorePrompt,
  onLoadSelectedRestoreDraft,
  onCloseSubmitWithoutProjectPrompt,
  onConfirmSubmitWithoutProject,
  onCloseMissingPathPrompt,
  onConfirmCreateMissingPath,
  onCloseManualPathPicker,
  onManualPathGoUp,
  onManualPathRefresh,
  onOpenManualPathEntry,
  onSelectManualCurrentPath,
  onCloseDraftModal,
  onLoadDraft,
  onDeleteDraft,
  onClearDrafts,
}: CreateTaskModalOverlaysProps) {
  return (
    <>
      {restorePromptOpen && selectedRestoreDraft && (
        <div
          className="fixed inset-0 z-[58] flex items-center justify-center bg-black/65 p-4"
          onClick={onCloseRestorePrompt}
        >
          <div
            className="w-full max-w-md overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="border-b border-slate-700 px-4 py-3">
              <h3 className="text-sm font-semibold text-white">
                {t({
                  en: "Restore Draft",
                })}
              </h3>
            </div>
            <div className="space-y-2 px-4 py-4">
              <p className="text-sm text-slate-200">
                {t({
                  en: "There is previously entered data. Would you like to load it?",
                })}
              </p>
              <p className="text-xs text-slate-400">
                {t({
                  en: "Recent drafts (up to 3)",
                })}
              </p>
              <div className="space-y-2">
                {restoreCandidates.map((draft) => {
                  const isSelected = selectedRestoreDraftId === draft.id;
                  return (
                    <button
                      key={draft.id}
                      type="button"
                      onClick={() => onSelectRestoreDraft(draft.id)}
                      className={`w-full rounded-lg border px-3 py-2 text-left transition ${
                        isSelected
                          ? "border-blue-500 bg-blue-500/15"
                          : "border-slate-700 bg-slate-800/70 hover:bg-slate-800"
                      }`}
                    >
                      <p className="truncate text-sm font-semibold text-slate-100">
                        {draft.title ||
                          t({
                            en: "(Untitled)",
                          })}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-400">
                        {formatDraftTimestamp(draft.updatedAt)} · {timeAgo(draft.updatedAt, localeTag)}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-700 px-4 py-3">
              <button
                type="button"
                onClick={onCloseRestorePrompt}
                className="rounded-md border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
              >
                {t({ en: "Start Fresh" })}
              </button>
              <button
                type="button"
                onClick={onLoadSelectedRestoreDraft}
                className="rounded-md ax-btn-primary px-3 py-1.5 text-xs font-semibold transition"
              >
                {t({ en: "Load" })}
              </button>
            </div>
          </div>
        </div>
      )}

      {submitWithoutProjectPromptOpen && (
        <div
          className="fixed inset-0 z-[59] flex items-center justify-center bg-black/70 p-4"
          onClick={onCloseSubmitWithoutProjectPrompt}
        >
          <div
            className="w-full max-w-md overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="border-b border-slate-700 px-4 py-3">
              <h3 className="text-sm font-semibold text-white">
                {t({
                  en: "Create Without Project",
                })}
              </h3>
            </div>
            <div className="space-y-2 px-4 py-4">
              <p className="text-sm text-slate-200">
                {t({
                  en: "Create this task without a project link?",
                })}
              </p>
              <p className="text-xs text-slate-400">
                {t({
                  en: "It will not appear in project history.",
                })}
              </p>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-700 px-4 py-3">
              <button
                type="button"
                onClick={onCloseSubmitWithoutProjectPrompt}
                className="rounded-md border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
              >
                {t({ en: "Cancel" })}
              </button>
              <button
                type="button"
                onClick={onConfirmSubmitWithoutProject}
                className="rounded-md ax-btn-primary px-3 py-1.5 text-xs font-semibold transition"
              >
                {t({ en: "Continue" })}
              </button>
            </div>
          </div>
        </div>
      )}

      {missingPathPrompt && (
        <div
          className="fixed inset-0 z-[59] flex items-center justify-center bg-black/70 p-4"
          onClick={onCloseMissingPathPrompt}
        >
          <div
            className="w-full max-w-md overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="border-b border-slate-700 px-4 py-3">
              <h3 className="text-sm font-semibold text-white">
                {t({
                  en: "Confirm Project Path",
                })}
              </h3>
            </div>
            <div className="space-y-2 px-4 py-4">
              <p className="text-sm text-slate-200">
                {t({
                  en: "This path does not exist. Create it now?",
                })}
              </p>
              <p className="break-all rounded-md border border-slate-700 bg-slate-800/70 px-2.5 py-2 text-xs text-slate-200">
                {missingPathPrompt.normalizedPath}
              </p>
              {missingPathPrompt.nearestExistingParent && (
                <p className="text-xs text-slate-400">
                  {t({
                    en: `Base folder: ${missingPathPrompt.nearestExistingParent}`,
                  })}
                </p>
              )}
              {!missingPathPrompt.canCreate && (
                <p className="text-xs text-amber-300">
                  {t({
                    en: "This path is not creatable with current permissions. Choose another path.",
                  })}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-700 px-4 py-3">
              <button
                type="button"
                onClick={onCloseMissingPathPrompt}
                className="rounded-md border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
              >
                {t({ en: "Cancel" })}
              </button>
              <button
                type="button"
                disabled={!missingPathPrompt.canCreate || submitBusy}
                onClick={onConfirmCreateMissingPath}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t({ en: "Yes" })}
              </button>
            </div>
          </div>
        </div>
      )}

      {manualPathPickerOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
          onClick={onCloseManualPathPicker}
        >
          <div
            className="w-full max-w-2xl overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
              <h3 className="text-sm font-semibold text-white">
                {t({
                  en: "In-App Folder Browser",
                })}
              </h3>
              <button
                type="button"
                onClick={onCloseManualPathPicker}
                className="rounded-md px-2 py-1 text-xs text-slate-400 transition hover:bg-slate-800 hover:text-white"
              >
                ✕
              </button>
            </div>
            <div className="space-y-3 px-4 py-4">
              <div className="rounded-lg border border-slate-700 bg-slate-800/70 px-3 py-2">
                <p className="text-[11px] text-slate-400">{t({ en: "Current Location" })}</p>
                <p className="break-all text-xs text-slate-200">{manualPathCurrent || "-"}</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={!manualPathParent || manualPathLoading}
                  onClick={onManualPathGoUp}
                  className="rounded-md border border-slate-600 px-2.5 py-1 text-xs font-semibold text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {t({ en: "Up" })}
                </button>
                <button
                  type="button"
                  disabled={manualPathLoading}
                  onClick={onManualPathRefresh}
                  className="rounded-md border border-slate-600 px-2.5 py-1 text-xs font-semibold text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {t({ en: "Refresh" })}
                </button>
              </div>
              <div className="max-h-[45dvh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-800/50">
                {manualPathLoading ? (
                  <p className="px-3 py-2 text-xs text-slate-400">
                    {t({
                      en: "Loading directories...",
                    })}
                  </p>
                ) : manualPathError ? (
                  <p className="px-3 py-2 text-xs text-rose-300">{manualPathError}</p>
                ) : manualPathEntries.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-slate-400">
                    {t({
                      en: "No selectable subdirectories.",
                    })}
                  </p>
                ) : (
                  manualPathEntries.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      onClick={() => onOpenManualPathEntry(entry.path)}
                      className="w-full border-b border-slate-700/70 px-3 py-2 text-left transition hover:bg-slate-700/60"
                    >
                      <p className="text-xs font-semibold text-slate-100">{entry.name}</p>
                      <p className="truncate text-[11px] text-slate-400">{entry.path}</p>
                    </button>
                  ))
                )}
              </div>
              {manualPathTruncated && (
                <p className="text-[11px] text-slate-400">
                  {t({
                    en: "Only the first 300 directories are shown.",
                  })}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-700 px-4 py-3">
              <button
                type="button"
                onClick={onCloseManualPathPicker}
                className="rounded-md border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
              >
                {t({ en: "Cancel" })}
              </button>
              <button
                type="button"
                disabled={!manualPathCurrent}
                onClick={onSelectManualCurrentPath}
                className="rounded-md ax-btn-primary px-3 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t({
                  en: "Select Current Folder",
                })}
              </button>
            </div>
          </div>
        </div>
      )}

      {draftModalOpen && (
        <div
          className="fixed inset-0 z-[61] flex items-center justify-center bg-black/70 p-4"
          onClick={onCloseDraftModal}
        >
          <div
            className="w-full max-w-xl overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
              <h3 className="text-sm font-semibold text-white">{t({ en: "Temporary Drafts" })}</h3>
              <button
                type="button"
                onClick={onCloseDraftModal}
                className="rounded-md px-2 py-1 text-xs text-slate-400 transition hover:bg-slate-800 hover:text-white"
                title={t({ en: "Close" })}
              >
                ✕
              </button>
            </div>

            <div className="max-h-[55dvh] space-y-2 overflow-y-auto px-4 py-3">
              {drafts.length === 0 ? (
                <div className="rounded-lg border border-slate-700 bg-slate-800/70 px-3 py-4 text-center text-sm text-slate-400">
                  {t({
                    en: "No temporary drafts saved.",
                  })}
                </div>
              ) : (
                drafts.map((draft) => (
                  <div key={draft.id} className="rounded-lg border border-slate-700 bg-slate-800/70 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-100">
                          {draft.title ||
                            t({
                              en: "(Untitled)",
                            })}
                        </p>
                        <p className="mt-0.5 text-xs text-slate-400">
                          {formatDraftTimestamp(draft.updatedAt)} · {timeAgo(draft.updatedAt, localeTag)}
                        </p>
                        {draft.description.trim() && (
                          <p className="mt-1 line-clamp-2 text-xs text-slate-300">{draft.description}</p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => onLoadDraft(draft)}
                          className="rounded-md ax-btn-primary px-2.5 py-1 text-xs font-semibold transition"
                        >
                          {t({ en: "Load" })}
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteDraft(draft.id)}
                          className="rounded-md border border-red-500/70 px-2.5 py-1 text-xs font-semibold text-red-300 transition hover:bg-red-500/10"
                        >
                          {t({ en: "Delete" })}
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="flex justify-end border-t border-slate-700 px-4 py-3">
              <button
                type="button"
                onClick={onClearDrafts}
                disabled={drafts.length === 0}
                className="rounded-md border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t({ en: "Delete All" })}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
