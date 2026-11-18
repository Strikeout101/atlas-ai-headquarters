import type { Lang } from "../../../types/lang.ts";
import type { L10n } from "./language-policy.ts";

interface MessageDeps {
  l: (en: string[]) => L10n;
  pickL: (pool: L10n, lang: Lang) => string;
}

interface QueueProgressParams extends MessageDeps {
  lang: Lang;
  targetDeptName: string;
  queueIndex: number;
  queueTotal: number;
  itemCount: number;
}

interface OriginRequestParams extends MessageDeps {
  lang: Lang;
  crossLeaderName: string;
  parentTitle: string;
  itemCount: number;
  batchTitle: string;
}

interface CrossLeaderAckParams extends MessageDeps {
  lang: Lang;
  hasSubordinate: boolean;
  originLeaderName: string;
  itemCount: number;
  batchTitle: string;
  execName: string;
}

interface DelegatedDescriptionParams extends MessageDeps {
  lang: Lang;
  sourceDeptName: string;
  parentSummary: string;
  delegatedChecklist: string;
}

interface ExecutionStartParams extends MessageDeps {
  lang: Lang;
  targetDeptName: string;
  execName: string;
  itemCount: number;
  worktreeCeoNote: string;
}

export function teamLeadFallbackLabel(deps: MessageDeps, lang: Lang): string {
  return deps.pickL(deps.l(["Team Lead"]), lang);
}

export function buildQueueProgressNotice(params: QueueProgressParams): string {
  const { l, pickL, lang, targetDeptName, queueIndex, queueTotal, itemCount } = params;
  return pickL(
    l([
      `Batched subtask delegation in progress: ${targetDeptName} (${queueIndex + 1}/${queueTotal}, ${itemCount} item(s))`,
    ]),
    lang,
  );
}

export function buildOriginRequestMessage(params: OriginRequestParams): string {
  const { l, pickL, lang, crossLeaderName, parentTitle, itemCount, batchTitle } = params;
  return pickL(
    l([
      `${crossLeaderName}, please process ${itemCount} subtasks (${batchTitle}) for '${parentTitle}' as one sequential checklist in a single run. 🤝`,
    ]),
    lang,
  );
}

export function buildCrossLeaderAckMessage(params: CrossLeaderAckParams): string {
  const { l, pickL, lang, hasSubordinate, originLeaderName, itemCount, batchTitle, execName } = params;
  if (hasSubordinate) {
    return pickL(
      l([
        `Got it, ${originLeaderName}! I'll assign ${itemCount} items (${batchTitle}) to ${execName} as one ordered batch. 👍`,
      ]),
      lang,
    );
  }

  return pickL(
    l([`Understood, ${originLeaderName}! I'll handle ${itemCount} items (${batchTitle}) myself in order. 👍`]),
    lang,
  );
}

export function buildDelegatedTitle(deps: MessageDeps, lang: Lang, itemCount: number, batchTitle: string): string {
  return deps.pickL(deps.l([`[Batched Subtask Collaboration x${itemCount}] ${batchTitle}`]), lang);
}

export function buildDelegatedDescription(params: DelegatedDescriptionParams): string {
  const { l, pickL, lang, sourceDeptName, parentSummary, delegatedChecklist } = params;
  return pickL(
    l([
      `[Subtasks delegated from ${sourceDeptName}] ${parentSummary}\n\n[Sequential checklist]\n${delegatedChecklist}`,
    ]),
    lang,
  );
}

export function buildWorktreeCeoNote(
  deps: MessageDeps,
  lang: Lang,
  delegatedTaskId: string,
  hasWorktree: boolean,
): string {
  if (!hasWorktree) return "";
  return deps.pickL(deps.l([` (isolated branch: climpire/${delegatedTaskId.slice(0, 8)})`]), lang);
}

export function buildExecutionStartNotice(params: ExecutionStartParams): string {
  const { l, pickL, lang, targetDeptName, execName, itemCount, worktreeCeoNote } = params;
  return pickL(
    l([`${targetDeptName} ${execName} started one batched run for ${itemCount} subtasks.${worktreeCeoNote}`]),
    lang,
  );
}
