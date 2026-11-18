type CompactPromptInput = {
  taskId: string;
  title: string;
  checkpointText: string;
  contextWindowTokens?: number | null;
  departmentConstraint?: string | null;
  departmentSharedPrompt?: string | null;
  interruptPrompt?: string | null;
  taskToolsPath?: string | null;
  worktreeBranch: string;
  /**
   * Compact project goal and memories for this task, sized to the bytes still free (see buildCompactKnowledgeBlock).
   * Called once the mandatory parts fit; returns "" when there is no room.
   */
  knowledge?: ((maxBytes: number) => string) | null;
};

function clipMiddle(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const head = Math.ceil(limit * 0.65);
  const tail = Math.max(0, limit - head - 40);
  return `${value.slice(0, head)}\n[checkpoint excerpt omitted]\n${value.slice(-tail)}`;
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function buildCompactContextRolloverPrompt(
  input: CompactPromptInput,
  finalize: (parts: string[]) => string,
): string {
  const window = Number(input.contextWindowTokens);
  // UTF-8 bytes conservatively bound text tokens across languages. Keep room for OpenCode tools and output.
  const maxPromptBytes = Number.isSafeInteger(window) && window > 0 ? Math.floor(window * 0.65) : 7_000;
  const fixed = [
    `[Task Session] task=${input.taskId}; fresh context, same task and worktree`,
    `[Task] ${input.title}`,
    input.departmentConstraint ? clipMiddle(input.departmentConstraint, 300) : "",
    input.departmentSharedPrompt ? clipMiddle(input.departmentSharedPrompt, 400) : "",
    input.interruptPrompt ? clipMiddle(input.interruptPrompt, 600) : "",
    `Work in the existing isolated branch ${input.worktreeBranch}. Continue from its current files. Run relevant tests. Do not commit until the user explicitly approves.`,
    input.taskToolsPath
      ? `Task tools: ${input.taskToolsPath} (task token in the environment). Full reference: knowledge.get {"topic":"tools"}. Use model.request_upgrade if a stronger model is needed.`
      : "",
    "Customer-facing sends, SSH changes and all spending go through approval; if something is pending, end this run and report it. Never use mail or Square credentials, mark a deal paid, publish a listing, or move money.",
    "Complete the remaining work directly.",
  ].filter(Boolean);
  const render = (checkpointLimit: number, knowledge = "") =>
    finalize([
      fixed[0]!,
      fixed[1]!,
      `[Durable checkpoint]\n${clipMiddle(input.checkpointText, checkpointLimit)}`,
      ...(knowledge ? [knowledge] : []),
      ...fixed.slice(2),
    ]);
  let checkpointLimit = Math.min(5_000, input.checkpointText.length);
  let prompt = render(checkpointLimit);
  while (bytes(prompt) > maxPromptBytes && checkpointLimit > 256) {
    checkpointLimit = Math.max(256, Math.floor(checkpointLimit * 0.7));
    prompt = render(checkpointLimit);
  }
  if (bytes(prompt) > maxPromptBytes) {
    throw new Error("context_rollover_prompt_exceeds_configured_window");
  }
  // Knowledge only uses room the checkpoint left free; the checkpoint always wins.
  if (input.knowledge) {
    let knowledge = "";
    try {
      knowledge = input.knowledge(maxPromptBytes - bytes(prompt) - 1);
    } catch {
      knowledge = "";
    }
    if (knowledge) {
      const withKnowledge = render(checkpointLimit, knowledge);
      if (bytes(withKnowledge) <= maxPromptBytes) prompt = withKnowledge;
    }
  }
  return prompt;
}
