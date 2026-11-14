type CompactPromptInput = {
  taskId: string;
  title: string;
  checkpointText: string;
  contextWindowTokens?: number | null;
  workflowGuidance?: string | null;
  departmentConstraint?: string | null;
  departmentSharedPrompt?: string | null;
  interruptPrompt?: string | null;
  taskToolsPath?: string | null;
  worktreeBranch: string;
};

function clipMiddle(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const head = Math.ceil(limit * 0.65);
  const tail = Math.max(0, limit - head - 40);
  return `${value.slice(0, head)}\n[checkpoint excerpt omitted]\n${value.slice(-tail)}`;
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
    input.workflowGuidance ? `[Workflow Pack Execution Rules]\n${clipMiddle(input.workflowGuidance, 500)}` : "",
    input.departmentConstraint ? clipMiddle(input.departmentConstraint, 300) : "",
    input.departmentSharedPrompt ? clipMiddle(input.departmentSharedPrompt, 400) : "",
    input.interruptPrompt ? clipMiddle(input.interruptPrompt, 600) : "",
    `Work in the existing isolated branch ${input.worktreeBranch}. Continue from its current files. Run relevant tests. Do not commit until the user explicitly approves.`,
    input.taskToolsPath
      ? `Task tools: ${input.taskToolsPath}. Use model.request_upgrade if a stronger model is needed. The task token is in the environment.`
      : "",
    "Do not run agent SSH without the owner's approval. Do not handle payments or money movement. Keep outbound business messages as drafts until approved.",
    "Complete the remaining work directly.",
  ].filter(Boolean);
  const render = (checkpointLimit: number) =>
    finalize([
      fixed[0]!,
      fixed[1]!,
      `[Durable checkpoint]\n${clipMiddle(input.checkpointText, checkpointLimit)}`,
      ...fixed.slice(2),
    ]);
  let checkpointLimit = Math.min(5_000, input.checkpointText.length);
  let prompt = render(checkpointLimit);
  while (Buffer.byteLength(prompt, "utf8") > maxPromptBytes && checkpointLimit > 256) {
    checkpointLimit = Math.max(256, Math.floor(checkpointLimit * 0.7));
    prompt = render(checkpointLimit);
  }
  if (Buffer.byteLength(prompt, "utf8") > maxPromptBytes) {
    throw new Error("context_rollover_prompt_exceeds_configured_window");
  }
  return prompt;
}
