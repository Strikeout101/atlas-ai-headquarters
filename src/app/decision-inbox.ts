import type { DecisionInboxRouteItem } from "../api";
import { normalizeLanguage, pickLang, type UiLanguage } from "../i18n";
import type { DecisionInboxItem } from "../components/chat/decision-inbox";

function baseWorkflowDecisionItem(item: DecisionInboxRouteItem): Omit<DecisionInboxItem, "options"> {
  return {
    id: item.id,
    kind: item.kind,
    agentId: item.agent_id ?? null,
    agentName: item.agent_name || item.task_title || item.task_id || "Task",
    agentNameKo: item.agent_name || item.agent_name_ko || item.task_title || item.task_id || "Task",
    agentAvatar: item.agent_avatar ?? (item.kind === "review_owner" ? "🧾" : null),
    requestContent: item.summary,
    createdAt: item.created_at,
    taskId: item.task_id,
    projectId: item.project_id,
    projectName: item.project_name,
  };
}

function localizedOptionLabel(
  kind: DecisionInboxItem["kind"],
  action: string,
  number: number,
  language: UiLanguage,
): string {
  if (kind === "task_timeout_resume") {
    if (action === "resume_timeout_task") {
      return pickLang(language, {
        en: "Resume Task",
      });
    }
    if (action === "keep_inbox") {
      return pickLang(language, {
        en: "Keep in Inbox",
      });
    }
  }
  if (kind === "review_owner") {
    if (action === "review_retry") return pickLang(language, { en: "One more go with the review's list" });
    if (action === "review_accept") return pickLang(language, { en: "Accept it as is" });
    if (action === "review_drop") return pickLang(language, { en: "Drop the task" });
  }
  return `${number}. ${action}`;
}

export function mapWorkflowDecisionItemsRaw(items: DecisionInboxRouteItem[]): DecisionInboxItem[] {
  return items.map((item) => ({
    ...baseWorkflowDecisionItem(item),
    options: item.options.map((option) => ({
      number: option.number,
      label: option.label ?? option.action,
      action: option.action,
    })),
  }));
}

export function mapWorkflowDecisionItemsLocalized(
  items: DecisionInboxRouteItem[],
  language: string,
): DecisionInboxItem[] {
  const locale = normalizeLanguage(language);
  return items.map((item) => ({
    ...baseWorkflowDecisionItem(item),
    options: item.options.map((option) => ({
      number: option.number,
      label: option.label ?? localizedOptionLabel(item.kind, option.action, option.number, locale),
      action: option.action,
    })),
  }));
}
