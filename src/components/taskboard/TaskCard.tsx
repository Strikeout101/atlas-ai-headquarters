import { useState } from "react";
import {
  Eye,
  EyeOff,
  FileText,
  GitCompare,
  Link2,
  Pause,
  Play,
  RotateCcw,
  Square,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import type { Agent, Department, SubTask, Task, TaskStatus } from "../../types";
import { useI18n } from "../../i18n";
import AgentAvatar from "../AgentAvatar";
import AgentSelect from "../AgentSelect";
import DiffModal from "./DiffModal";
import {
  getTaskTypeBadge,
  isHideableStatus,
  priorityLabel,
  STATUS_OPTIONS,
  taskStatusLabel,
  timeAgo,
} from "./constants";

interface TaskCardProps {
  task: Task;
  agents: Agent[];
  departments: Department[];
  taskSubtasks: SubTask[];
  isHiddenTask?: boolean;
  onUpdateTask: (id: string, data: Partial<Task>) => void;
  onDeleteTask: (id: string) => void;
  onAssignTask: (taskId: string, agentId: string) => void;
  onRunTask: (id: string) => void;
  onStopTask: (id: string) => void;
  onPauseTask?: (id: string) => void;
  onResumeTask?: (id: string) => void;
  onOpenTerminal?: (taskId: string) => void;
  onOpenMeetingMinutes?: (taskId: string) => void;
  onMergeTask?: (id: string) => void;
  onDiscardTask?: (id: string) => void;
  onHideTask?: (id: string) => void;
  onUnhideTask?: (id: string) => void;
}

const SUBTASK_STATUS_ICON: Record<string, string> = {
  pending: "\u23F3",
  in_progress: "\uD83D\uDD28",
  done: "\u2705",
  blocked: "\uD83D\uDEAB",
};

export default function TaskCard({
  task,
  agents,
  departments,
  taskSubtasks,
  isHiddenTask,
  onUpdateTask,
  onDeleteTask,
  onAssignTask,
  onRunTask,
  onStopTask,
  onPauseTask,
  onResumeTask,
  onOpenTerminal,
  onOpenMeetingMinutes,
  onMergeTask,
  onDiscardTask,
  onHideTask,
  onUnhideTask,
}: TaskCardProps) {
  void onMergeTask;
  void onDiscardTask;
  const { t, locale: localeTag, language: locale } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [showSubtasks, setShowSubtasks] = useState(false);
  const [agentWarning, setAgentWarning] = useState(false);

  const assignedAgent = task.assigned_agent ?? agents.find((agent) => agent.id === task.assigned_agent_id);
  const fallbackAssignedName =
    (locale === "ko" ? task.agent_name_ko || task.agent_name : task.agent_name || task.agent_name_ko) ||
    task.assigned_agent_id;
  const assignedDisplayName = assignedAgent ? (locale === "ko" ? assignedAgent.name_ko : assignedAgent.name) : null;
  const assignedLabel = assignedDisplayName || fallbackAssignedName || null;
  const department = departments.find((d) => d.id === task.department_id);
  const typeBadge = getTaskTypeBadge(task.task_type, t);

  const canRun = task.status === "planned" || task.status === "inbox";
  const canStop = task.status === "in_progress";
  const canPause = task.status === "in_progress" && !!onPauseTask;
  const canResume = (task.status === "pending" || task.status === "cancelled") && !!onResumeTask;
  const canDelete = task.status !== "in_progress";
  const canHideTask = isHideableStatus(task.status);

  return (
    <div
      className={`ax-task-card ax-lift group rounded-[9px] border p-3.5 ${isHiddenTask ? "opacity-75" : ""}`}
      data-status={task.status}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 text-left text-[13.5px] font-medium leading-snug"
          style={{ color: "var(--th-text-heading)" }}
        >
          {task.title}
        </button>
        <span
          className="ax-priority mt-0.5 flex-shrink-0"
          data-level={task.priority >= 4 ? "high" : task.priority >= 2 ? "medium" : "low"}
          title={`${t({ ko: "우선순위", en: "Priority", ja: "優先度", zh: "优先级" })}: ${priorityLabel(task.priority, t)}`}
          aria-label={priorityLabel(task.priority, t)}
        >
          <i />
          <i />
          <i />
        </span>
      </div>

      {task.description && (
        <p className={`mb-2 text-xs leading-relaxed text-slate-400 ${expanded ? "" : "line-clamp-2"}`}>
          {task.description}
        </p>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${typeBadge.color}`}>{typeBadge.label}</span>
        {isHiddenTask && (
          <span className="rounded-full bg-cyan-900/60 px-2 py-0.5 text-xs text-cyan-200">
            <EyeOff size={11} className="mr-1 inline -mt-px" />
            {t({ ko: "숨김", en: "Hidden", ja: "非表示", zh: "隐藏" })}
          </span>
        )}
        {department && (
          <span className="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">
            {department.icon} {locale === "ko" ? department.name_ko : department.name}
          </span>
        )}
      </div>

      <div className="mb-3">
        <select
          value={task.status}
          onChange={(event) => onUpdateTask(task.id, { status: event.target.value as TaskStatus })}
          className="w-full rounded-lg border border-slate-600 bg-slate-700 px-2 py-1 text-xs text-white outline-none transition focus:border-blue-500"
        >
          {STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {taskStatusLabel(status as TaskStatus, t)}
            </option>
          ))}
        </select>
      </div>

      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {assignedAgent && assignedLabel ? (
            <>
              <AgentAvatar agent={assignedAgent} agents={agents} size={20} />
              <span className="text-xs text-slate-300">{assignedLabel}</span>
            </>
          ) : assignedLabel ? (
            <span className="text-xs text-slate-300">{assignedLabel}</span>
          ) : (
            <span className="text-xs text-slate-500">
              {t({ ko: "미배정", en: "Unassigned", ja: "未割り当て", zh: "未分配" })}
            </span>
          )}
        </div>
        <span className="text-xs text-slate-500">{timeAgo(task.created_at, localeTag)}</span>
      </div>

      <div
        className={`mb-3 rounded-lg transition-all ${agentWarning ? "ring-2 ring-red-500 animate-[shake_0.4s_ease-in-out]" : ""}`}
      >
        <AgentSelect
          agents={agents}
          departments={departments}
          value={task.assigned_agent_id ?? ""}
          placeholder={
            assignedAgent || !assignedLabel
              ? undefined
              : t({
                  ko: `배정됨(숨김): ${assignedLabel}`,
                  en: `Assigned (hidden): ${assignedLabel}`,
                  ja: `割り当て済み(非表示): ${assignedLabel}`,
                  zh: `已分配（隐藏）: ${assignedLabel}`,
                })
          }
          onChange={(agentId) => {
            setAgentWarning(false);
            if (agentId) {
              onAssignTask(task.id, agentId);
            } else {
              onUpdateTask(task.id, { assigned_agent_id: null });
            }
          }}
        />
        {agentWarning && (
          <p className="mt-1 text-xs font-medium text-red-400 animate-[shake_0.4s_ease-in-out]">
            {t({
              ko: "담당자를 배정해주세요!",
              en: "Please assign an agent!",
              ja: "担当者を割り当ててください！",
              zh: "请分配负责人！",
            })}
          </p>
        )}
      </div>

      {(task.subtask_total ?? 0) > 0 && (
        <div className="mb-3">
          <button
            onClick={() => setShowSubtasks((v) => !v)}
            className="mb-1.5 flex w-full items-center gap-2 text-left"
          >
            <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  background: "var(--ax-done)",
                  width: `${Math.round(((task.subtask_done ?? 0) / (task.subtask_total ?? 1)) * 100)}%`,
                }}
              />
            </div>
            <span className="text-xs text-slate-400 whitespace-nowrap">
              {task.subtask_done ?? 0}/{task.subtask_total ?? 0}
            </span>
            <span className="text-xs text-slate-500">{showSubtasks ? "▲" : "▼"}</span>
          </button>
          {showSubtasks && taskSubtasks.length > 0 && (
            <div className="space-y-1 pl-1">
              {taskSubtasks.map((subtask) => {
                const targetDepartment = subtask.target_department_id
                  ? departments.find((departmentItem) => departmentItem.id === subtask.target_department_id)
                  : null;
                return (
                  <div key={subtask.id} className="flex items-center gap-1.5 text-xs">
                    <span>{SUBTASK_STATUS_ICON[subtask.status] || "\u23F3"}</span>
                    <span
                      className={`flex-1 truncate ${subtask.status === "done" ? "line-through text-slate-500" : "text-slate-300"}`}
                    >
                      {subtask.title}
                    </span>
                    {targetDepartment && (
                      <span
                        className="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium"
                        style={{ backgroundColor: targetDepartment.color + "30", color: targetDepartment.color }}
                      >
                        {targetDepartment.icon} {targetDepartment.name_ko}
                      </span>
                    )}
                    {subtask.delegated_task_id && subtask.status !== "done" && (
                      <span
                        className="text-blue-400 shrink-0"
                        title={t({ ko: "위임됨", en: "Delegated", ja: "委任済み", zh: "已委派" })}
                      >
                        <Link2 size={11} />
                      </span>
                    )}
                    {subtask.status === "blocked" && subtask.blocked_reason && (
                      <span className="text-red-400 text-[10px] truncate max-w-[80px]" title={subtask.blocked_reason}>
                        {subtask.blocked_reason}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {canRun && (
          <button
            onClick={() => {
              if (!task.assigned_agent_id) {
                setAgentWarning(true);
                setTimeout(() => setAgentWarning(false), 3000);
                return;
              }
              onRunTask(task.id);
            }}
            title={t({ ko: "작업 실행", en: "Run task", ja: "タスク実行", zh: "运行任务" })}
            className="ax-act flex-1"
            data-tone="go"
          >
            <Play size={12} strokeWidth={2.25} /> {t({ ko: "실행", en: "Run", ja: "実行", zh: "运行" })}
          </button>
        )}
        {canPause && (
          <button
            onClick={() => onPauseTask!(task.id)}
            title={t({ ko: "작업 일시중지", en: "Pause task", ja: "タスク一時停止", zh: "暂停任务" })}
            className="ax-act flex-1"
            data-tone="warn"
          >
            <Pause size={12} strokeWidth={2.25} /> {t({ ko: "일시중지", en: "Pause", ja: "一時停止", zh: "暂停" })}
          </button>
        )}
        {canStop && (
          <button
            onClick={() => {
              if (
                confirm(
                  t({
                    ko: `"${task.title}" 작업을 중지할까요?\n\n경고: Stop 처리 시 해당 프로젝트 변경분은 롤백됩니다.`,
                    en: `Stop "${task.title}"?\n\nWarning: stopping will roll back project changes.`,
                    ja: `「${task.title}」を停止しますか？\n\n警告: 停止するとプロジェクトの変更はロールバックされます。`,
                    zh: `要停止“${task.title}”吗？\n\n警告：停止后将回滚该项目的更改。`,
                  }),
                )
              ) {
                onStopTask(task.id);
              }
            }}
            title={t({ ko: "작업 중지", en: "Cancel task", ja: "タスク停止", zh: "取消任务" })}
            className="ax-act"
            data-tone="danger"
          >
            <Square size={11} strokeWidth={2.25} /> {t({ ko: "중지", en: "Cancel", ja: "キャンセル", zh: "取消" })}
          </button>
        )}
        {canResume && (
          <button
            onClick={() => onResumeTask!(task.id)}
            title={t({ ko: "작업 재개", en: "Resume task", ja: "タスク再開", zh: "恢复任务" })}
            className="ax-act flex-1"
            data-tone="go"
          >
            <RotateCcw size={12} strokeWidth={2} /> {t({ ko: "재개", en: "Resume", ja: "再開", zh: "恢复" })}
          </button>
        )}
        {(task.status === "in_progress" ||
          task.status === "review" ||
          task.status === "done" ||
          task.status === "pending") &&
          onOpenTerminal && (
            <button
              onClick={() => onOpenTerminal(task.id)}
              title={t({
                ko: "터미널 출력 보기",
                en: "View terminal output",
                ja: "ターミナル出力を見る",
                zh: "查看终端输出",
              })}
              className="ax-act"
            >
              <SquareTerminal size={13} strokeWidth={1.75} />
            </button>
          )}
        {(task.status === "planned" ||
          task.status === "collaborating" ||
          task.status === "in_progress" ||
          task.status === "review" ||
          task.status === "done" ||
          task.status === "pending") &&
          onOpenMeetingMinutes && (
            <button
              onClick={() => onOpenMeetingMinutes(task.id)}
              title={t({
                ko: "회의록 보기",
                en: "View meeting minutes",
                ja: "会議録を見る",
                zh: "查看会议纪要",
              })}
              className="ax-act"
            >
              <FileText size={13} strokeWidth={1.75} />
            </button>
          )}
        {task.status === "review" && (
          <button
            onClick={() => setShowDiff(true)}
            title={t({
              ko: "변경사항 보기 (Git diff)",
              en: "View changes (Git diff)",
              ja: "変更を見る (Git diff)",
              zh: "查看更改 (Git diff)",
            })}
            className="ax-act"
            data-tone="info"
          >
            <GitCompare size={12} strokeWidth={1.75} />
            {t({ ko: "Diff", en: "Diff", ja: "差分", zh: "差异" })}
          </button>
        )}
        {canHideTask && !isHiddenTask && onHideTask && (
          <button
            onClick={() => onHideTask(task.id)}
            title={t({
              ko: "완료/보류/취소 작업 숨기기",
              en: "Hide done/pending/cancelled task",
              ja: "完了/保留/キャンセルのタスクを非表示",
              zh: "隐藏已完成/待处理/已取消任务",
            })}
            className="ax-act"
          >
            <EyeOff size={12} strokeWidth={1.75} /> {t({ ko: "숨김", en: "Hide", ja: "非表示", zh: "隐藏" })}
          </button>
        )}
        {canHideTask && !!isHiddenTask && onUnhideTask && (
          <button
            onClick={() => onUnhideTask(task.id)}
            title={t({ ko: "숨긴 작업 복원", en: "Restore hidden task", ja: "非表示タスクを復元", zh: "恢复隐藏任务" })}
            className="ax-act"
            data-tone="info"
          >
            <Eye size={12} strokeWidth={1.75} /> {t({ ko: "복원", en: "Restore", ja: "復元", zh: "恢复" })}
          </button>
        )}
        {canDelete && (
          <button
            onClick={() => {
              if (
                confirm(
                  t({
                    ko: `"${task.title}" 업무를 삭제할까요?`,
                    en: `Delete "${task.title}"?`,
                    ja: `「${task.title}」を削除しますか？`,
                    zh: `要删除“${task.title}”吗？`,
                  }),
                )
              )
                onDeleteTask(task.id);
            }}
            title={t({ ko: "작업 삭제", en: "Delete task", ja: "タスク削除", zh: "删除任务" })}
            className="ax-act"
            data-tone="danger"
          >
            <Trash2 size={13} strokeWidth={1.75} />
          </button>
        )}
      </div>

      {showDiff && <DiffModal taskId={task.id} onClose={() => setShowDiff(false)} />}
    </div>
  );
}
