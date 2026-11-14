export type ContextRolloverReason = "near_limit" | "context_exhausted";

type MonitorOptions = {
  contextWindowTokens?: number | null;
  onNearLimit?: () => void;
};

const CONTEXT_ERROR =
  /context[_ -]?(?:length|window|size|limit).{0,90}(?:exceed|full|large|long|limit)|(?:exceed|maximum|too (?:large|long)).{0,90}context[_ -]?(?:length|window|size|limit)|prompt.{0,40}too long|context_length_exceeded|context_window_exceeded/i;

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function tokenCount(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function stepTokens(value: unknown): number | null {
  const data = asObject(value);
  if (!data) return null;
  const tokens = asObject(data.tokens) ?? asObject(data.usage);
  if (!tokens) return null;
  const input = tokenCount(tokens.input ?? tokens.input_tokens ?? tokens.prompt_tokens);
  const output = tokenCount(tokens.output ?? tokens.output_tokens ?? tokens.completion_tokens);
  const cache = asObject(tokens.cache);
  const cached = tokenCount(cache?.read) + tokenCount(cache?.write);
  const total = tokenCount(tokens.total ?? tokens.total_tokens);
  const used = Math.max(total, input + output + cached);
  return used > 0 ? used : null;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const error = asObject(value);
  if (!error) return "";
  const data = asObject(error.data);
  return [error.name, error.code, error.message, data?.code, data?.message]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
}

export function createOpenCodeContextMonitor(options: MonitorOptions = {}) {
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let reason: ContextRolloverReason | null = null;
  let latestTokens: number | null = null;
  const windowTokens = Number(options.contextWindowTokens);
  const threshold = Number.isSafeInteger(windowTokens) && windowTokens > 0 ? Math.ceil(windowTokens * 0.8) : null;

  function processJsonLine(line: string): void {
    let event: Record<string, unknown>;
    try {
      const parsed = asObject(JSON.parse(line));
      if (!parsed) return;
      event = parsed;
    } catch {
      return;
    }
    const type = String(event.type ?? "");
    const properties = asObject(event.properties);
    const part = asObject(event.part) ?? asObject(properties?.part);
    const partType = String(part?.type ?? "");
    const isError = type === "error" || type === "session.error" || partType === "error";
    if (isError && CONTEXT_ERROR.test(errorText(event.error ?? properties?.error ?? part?.error))) {
      reason = "context_exhausted";
      return;
    }
    const isStep =
      type === "step_finish" || type === "step-finish" || partType === "step_finish" || partType === "step-finish";
    if (!isStep) return;
    const used = stepTokens(part) ?? stepTokens(properties) ?? stepTokens(event);
    if (used === null) return;
    latestTokens = used;
    if (String(part?.reason ?? event.reason ?? "") === "stop") return;
    if (!reason && threshold !== null && used >= threshold) {
      reason = "near_limit";
      options.onNearLimit?.();
    }
  }

  function ingest(chunk: Buffer | string, stream: "stdout" | "stderr"): void {
    const value = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (stream === "stdout") {
      stdoutBuffer += value;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) processJsonLine(line.trim());
    } else {
      stderrBuffer += value;
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (/^(?:error:|\[error\]|\[opencode\].*error:)/i.test(line.trim()) && CONTEXT_ERROR.test(line)) {
          reason = "context_exhausted";
        }
      }
    }
  }

  function finish(): void {
    if (stdoutBuffer.trim()) processJsonLine(stdoutBuffer.trim());
    if (
      stderrBuffer.trim() &&
      /^(?:error:|\[error\]|\[opencode\].*error:)/i.test(stderrBuffer.trim()) &&
      CONTEXT_ERROR.test(stderrBuffer)
    ) {
      reason = "context_exhausted";
    }
    stdoutBuffer = "";
    stderrBuffer = "";
  }

  return {
    ingest,
    finish,
    get reason() {
      return reason;
    },
    get latestTokens() {
      return latestTokens;
    },
  };
}
