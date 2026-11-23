import type { DecisionInboxRouteItem } from "../api";
import { normalizeLanguage, pickLang, type UiLanguage } from "../i18n";
import type { DecisionInboxItem } from "../components/chat/decision-inbox";
import type { PendingApproval } from "../api/approvals";
import { formatMoney } from "../components/revenue/money";

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
        en: "Resume from where it stopped (recommended)",
      });
    }
    if (action === "keep_inbox") {
      return pickLang(language, {
        en: "Keep in Inbox",
      });
    }
  }
  if (kind === "review_owner") {
    if (action === "review_retry")
      return pickLang(language, { en: "One more go with the review's list (recommended)" });
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

/** The VPs' verdict is the recommendation; with none, keeping it pending comes first (never a default yes). */
function approvalOptions(review: PendingApproval["vp_review"]) {
  const verdicts = review?.reviews?.map((r) => r.verdict.toLowerCase()) ?? [];
  const vpsSayYes = verdicts.length > 0 && verdicts.every((v) => v.startsWith("approve"));
  const vpsSayNo =
    verdicts.length > 0 &&
    verdicts.every((v) => v.startsWith("den") || v.startsWith("decline") || v.startsWith("reject"));
  if (vpsSayYes)
    return [
      { number: 1, action: "approval_approve", label: "Approve this request (VPs recommend)" },
      { number: 2, action: "approval_decline", label: "Decline this request" },
      { number: 3, action: "approval_hold", label: "Keep pending while I check the details" },
    ];
  if (vpsSayNo)
    return [
      { number: 1, action: "approval_decline", label: "Decline this request (VPs recommend)" },
      { number: 2, action: "approval_approve", label: "Approve this request" },
      { number: 3, action: "approval_hold", label: "Keep pending while I check the details" },
    ];
  return [
    { number: 1, action: "approval_hold", label: "Keep pending while I check the details (recommended)" },
    { number: 2, action: "approval_approve", label: "Approve this request" },
    { number: 3, action: "approval_decline", label: "Decline this request" },
  ];
}

/** The same owner approval records Today shows, presented as short choices in one inbox. */
export function mapApprovalDecisionItems(items: PendingApproval[]): DecisionInboxItem[] {
  return items.map((item) => {
    const title =
      item.task_title || ("title" in item ? String(item.title ?? "") : "") || item.kind.replaceAll("_", " ");
    const detail =
      item.kind === "spend_request"
        ? `Spend ${formatMoney(item.amount_minor, item.currency, "en-US")} for ${item.purpose}. Approval records a decision; it does not move money.`
        : item.kind === "business_email"
          ? `Send this email once.\nFrom: ${item.sender}\nTo: ${item.recipient}\nSubject: ${item.subject || "(no subject)"}\n\n${item.body}`
          : item.kind === "listing_publish"
            ? `Review this ${item.platform} listing package. Approval allows publishing; it does not publish now.\n${item.title}\nPrice: ${formatMoney(item.price_minor, item.currency, "en-US")}\nTags: ${item.tags.join(", ")}\nFiles: ${item.files.join(", ")}\n\n${item.description}`
            : item.kind === "shop_change"
              ? `Apply these Etsy shop changes:\n${[
                  item.title && `Shop title: ${item.title}`,
                  item.announcement && `Announcement: ${item.announcement}`,
                  item.about && `About: ${item.about}`,
                  item.sale_message && `Sale message: ${item.sale_message}`,
                  item.digital_sale_message && `Digital sale message: ${item.digital_sale_message}`,
                  item.policy_additional && `Policy: ${item.policy_additional}`,
                  item.sections.length && `Sections: ${item.sections.join(", ")}`,
                  item.logo_path && `Logo: ${item.logo_path}`,
                  item.banner_path && `Banner: ${item.banner_path}`,
                ]
                  .filter(Boolean)
                  .join("\n")}`
              : item.kind === "code_push"
                ? `Push ${item.title} to ${item.github_repo} from ${item.branch}; opens a pull request without merging it.`
                : item.kind === "record_change"
                  ? `${item.summary}\nChange: ${JSON.stringify(item.payload).slice(0, 1200)}`
                  : item.kind === "ssh_command"
                    ? `Run this exact command on ${item.target_name ?? item.target_host ?? "the host"}: ${item.command ?? "(command unavailable; review in Homelab)"}`
                    : item.kind === "org_request"
                      ? `${item.org_kind.replaceAll("_", " ")}: ${item.reason}\n${JSON.stringify(item.payload).slice(0, 1000)}`
                      : item.kind === "model_upgrade"
                        ? `Use ${item.requested_provider ?? "the provider"} ${item.requested_model ?? "model"} for ${title}. ${item.reason}`
                        : item.kind === "task_proposal"
                          ? `Start this Operations idea: ${item.title}\n${item.description}\nWhy: ${item.reason}`
                          : title;
    return {
      id: `approval:${item.kind}:${item.id}`,
      kind: "approval" as const,
      agentId: item.agent_id,
      agentName: item.agent_name || item.agent_id,
      agentNameKo: item.agent_name || item.agent_id,
      requestContent: `${detail.slice(0, 3000)}${item.untrusted_content ? "\nThis request includes suspicious outside instructions; check the source." : ""}${item.vp_review?.reason ? `\nVPs: ${item.vp_review.reason.slice(0, 300)}` : ""}`,
      createdAt: item.created_at,
      taskId: item.task_id,
      approval: item,
      options: approvalOptions(item.vp_review),
    };
  });
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
