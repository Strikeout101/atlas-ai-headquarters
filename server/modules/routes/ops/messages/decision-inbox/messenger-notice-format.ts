import type { RuntimeContext } from "../../../../../types/runtime-context.ts";
import type { DecisionInboxRouteItem } from "./types.ts";

type NoticeFormatterDeps = {
  getPreferredLanguage: RuntimeContext["getPreferredLanguage"];
  normalizeTextField: RuntimeContext["normalizeTextField"];
};

export function createDecisionNoticeFormatter(deps: NoticeFormatterDeps) {
  const { getPreferredLanguage, normalizeTextField } = deps;

  function pickDecisionL10n(en: string): string {
    const lang = getPreferredLanguage();
    return en;
  }

  function truncateLine(value: string, max = 220): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length <= max) return normalized;
    return `${normalized.slice(0, max - 3).trimEnd()}...`;
  }

  function summarizeDecisionText(value: string, max = 120): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized) return "-";
    const cleaned = normalized
      .replace(/[*`]+/g, "")
      .replace(/^\s*[-•]\s*/g, "")
      .trim();
    return truncateLine(cleaned, max);
  }

  function splitDecisionLabel(raw: string): { title: string; detail: string } {
    const cleaned = summarizeDecisionText(raw, 240);
    const colonMatch = cleaned.match(/^([^:：]{1,48})[:：]\s*(.+)$/);
    if (!colonMatch) {
      return { title: cleaned, detail: "" };
    }
    const title = summarizeDecisionText(colonMatch[1] || "", 48);
    const detail = summarizeDecisionText(colonMatch[2] || "", 220);
    return { title, detail };
  }

  function isSkipOption(option: { action?: string; label?: string }): boolean {
    const source = `${option.label || ""} ${option.action || ""}`;
    return /skip/i.test(source);
  }

  function summarizeDecisionOptionStance(input: string): string {
    const text = summarizeDecisionText(input, 220);
    if (!text || text === "-") return pickDecisionL10n("Check details");
    if (/skip/i.test(text)) {
      return pickDecisionL10n("Move to next round");
    }
    if (/hold|pending|rework|remediation/i.test(text)) {
      return pickDecisionL10n("Remediate then review");
    }
    if (/approve|approved|ready|merge|go\b/i.test(text)) {
      return pickDecisionL10n("Approved / ready now");
    }
    const firstClause = text.split(/(?<=[.!?。！？])\s+|[,，;；]\s+/)[0] || text;
    return truncateLine(firstClause, 70);
  }

  function extractSummaryClauses(summary: string, maxClauses = 4): string[] {
    const cleaned = summary
      .replace(/\r/g, "\n")
      .replace(/\t/g, " ")
      .replace(/[•●]/g, "-")
      .split(/\n+/)
      .flatMap((line) => line.split(/(?<=[.!?。！？])\s+/))
      .map((line) => summarizeDecisionText(line, 220))
      .filter((line) => line && line !== "-");
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const clause of cleaned) {
      const key = clause.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(clause);
      if (deduped.length >= maxClauses) break;
    }
    return deduped;
  }

  function buildPlannerSummaryLines(item: DecisionInboxRouteItem): string[] {
    const lines: string[] = [];
    const summaryClauses = extractSummaryClauses(item.summary || "", 3);
    if (summaryClauses.length > 0) {
      lines.push(truncateLine(summaryClauses[0] || "", 95));
    }

    const nonSkipOptions = item.options.filter((option) => !isSkipOption(option));
    for (const option of nonSkipOptions.slice(0, 3)) {
      const { title, detail } = splitDecisionLabel(option.label || option.action || "-");
      const stance = summarizeDecisionOptionStance(detail || title);
      lines.push(truncateLine(`${title} - ${stance}`, 95));
    }

    if (lines.length < 3) {
      const fallback = pickDecisionL10n(
        `Choose priority option(s) from ${item.options.length} choices to apply immediately.`,
      );
      lines.push(truncateLine(fallback, 95));
    }

    return lines.slice(0, 5);
  }

  function parseRecommendedOptionNumbers(summary: string, validOptions: Array<{ number: number }>): number[] {
    const valid = new Set(validOptions.map((option) => option.number));
    const parseNumberList = (raw: string | undefined): number[] => {
      if (!raw) return [];
      const numbers: number[] = [];
      for (const match of raw.matchAll(/[1-9]\d?/g)) {
        const picked = Number.parseInt(match[0] || "", 10);
        if (!Number.isFinite(picked)) continue;
        if (!valid.has(picked)) continue;
        if (!numbers.includes(picked)) numbers.push(picked);
      }
      return numbers;
    };

    const normalized = summarizeDecisionText(summary || "", 1200);
    const preferredForward = normalized.match(
      /(?:preferred|recommend(?:ed|ation)?|suggest(?:ed)?)[^0-9]{0,24}([1-9]\d?(?:\s*[,/|+·\s]\s*[1-9]\d?){0,5})/i,
    );
    const preferredBackward = normalized.match(
      /([1-9]\d?(?:\s*[,/|+·\s]\s*[1-9]\d?){0,5})\s*(?:option)?\s*(?:preferred|recommend(?:ed|ation)?|suggest(?:ed)?)/i,
    );
    const preferred = parseNumberList(preferredForward?.[1] || preferredBackward?.[1]);
    if (preferred.length > 0) return preferred;

    const genericOptionMatch = normalized.match(/(?:option)\s*([1-9]\d?)/i);
    const generic = parseNumberList(genericOptionMatch?.[1]);
    if (generic.length > 0) return generic;

    return [];
  }

  function resolvePlanningLeadName(item: DecisionInboxRouteItem): string {
    const lang = getPreferredLanguage();
    return normalizeTextField(item.agent_name) || normalizeTextField(item.agent_name_ko) || "Planning Lead";
  }

  function resolveRecommendedOptions(item: DecisionInboxRouteItem): Array<{ number: number; title: string }> {
    const options = item.options;
    if (options.length <= 0) return [];

    const fromSummaryNumbers = parseRecommendedOptionNumbers(item.summary || "", options);
    if (fromSummaryNumbers.length > 0) {
      return fromSummaryNumbers
        .map((number) => options.find((option) => option.number === number) || null)
        .filter((option): option is (typeof options)[number] => option !== null)
        .map((option) => {
          const { title } = splitDecisionLabel(option.label || option.action || "-");
          return { number: option.number, title: truncateLine(title, 42) };
        });
    }

    const planningLeadFirst =
      options.find((option) => {
        if (isSkipOption(option)) return false;
        const source = `${option.label || ""} ${option.action || ""}`;
        return /planning|sage/i.test(source);
      }) ||
      options.find((option) => !isSkipOption(option)) ||
      options[0] ||
      null;
    const fallback = planningLeadFirst;
    if (!fallback) return [];
    const { title } = splitDecisionLabel(fallback.label || fallback.action || "-");
    return [{ number: fallback.number, title: truncateLine(title, 42) }];
  }

  function buildDecisionOptionPreview(option: { number: number; label: string; action: string }): string {
    const raw = option.label || option.action || "-";
    const { title, detail } = splitDecisionLabel(raw);
    const stance = summarizeDecisionOptionStance(detail || title);
    return `${option.number}. ${truncateLine(`${title}: ${stance}`, 92)}`;
  }

  function buildDecisionMessengerNotice(item: DecisionInboxRouteItem): string {
    const projectLabel =
      normalizeTextField(item.project_name) ||
      normalizeTextField(item.project_path) ||
      normalizeTextField(item.project_id) ||
      "-";
    const taskLabel = normalizeTextField(item.task_title);
    const plannerSummaryLines = buildPlannerSummaryLines(item);
    const recommendedOptions = resolveRecommendedOptions(item);
    const recommendedNumbers = recommendedOptions.map((option) => option.number).join(",");
    const planningLeadName = resolvePlanningLeadName(item);
    const options = item.options.slice(0, 8).map((option) => buildDecisionOptionPreview(option));
    const defaultOption = String(item.options[0]?.number ?? options[0]?.match(/^(\d+)/)?.[1] ?? 1);
    const isMultiPick = item.kind === "review_round_pick";
    const replyGuide =
      options.length > 0
        ? pickDecisionL10n(
            isMultiPick
              ? `Reply: send one or multiple option numbers (e.g., ${defaultOption} or ${defaultOption},3)`
              : `Reply: send only the option number (e.g., ${defaultOption})`,
          )
        : pickDecisionL10n("Reply with an option number");
    const lines = [
      `${pickDecisionL10n("Decision Request")}`,
      `${pickDecisionL10n("Project")}: ${projectLabel}`,
      ...(taskLabel ? [`${pickDecisionL10n("Task")}: ${truncateLine(taskLabel, 140)}`] : []),
      `${pickDecisionL10n("Planning lead summary")}:`,
      ...plannerSummaryLines.map((line) => `- ${line}`),
      ...(options.length > 0 ? [pickDecisionL10n("Options") + ":", ...options] : []),
      replyGuide,
      ...(recommendedOptions.length > 0
        ? [
            `${pickDecisionL10n("Planning lead")} ${planningLeadName}: ${pickDecisionL10n(
              `My recommendation is this. (Recommend ${recommendedNumbers})`,
            )}`,
            `${pickDecisionL10n("Recommended options")}: ${recommendedNumbers}`,
          ]
        : []),
    ];
    return lines.join("\n");
  }

  return {
    buildDecisionMessengerNotice,
  };
}
