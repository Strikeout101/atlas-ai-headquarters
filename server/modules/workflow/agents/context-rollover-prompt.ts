type CompactPromptInput = {
  taskId: string;
  title: string;
  checkpointText: string;
  preserveCheckpoint?: boolean;
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
  const hardLimit = Number.isSafeInteger(window) && window > 0 ? Math.floor(window * 0.65) : 7_000;
  // Reserve 15% of the prompt allowance for new context instead of filling every byte.
  const maxPromptBytes = Math.floor(hardLimit * 0.85);
  const fixed = [
    `[Task Session] ${input.taskId}; fresh context, same worktree`,
    `[Task] ${input.title}`,
    input.departmentConstraint ? clipMiddle(input.departmentConstraint, 300) : "",
    input.departmentSharedPrompt ? clipMiddle(input.departmentSharedPrompt, 400) : "",
    input.interruptPrompt ? clipMiddle(input.interruptPrompt, 600) : "",
    `Continue existing branch ${input.worktreeBranch}. Run relevant tests. Do not commit without explicit user approval.`,
    input.taskToolsPath
      ? `Tools: ${input.taskToolsPath}; token in env. Reference: knowledge.get {"topic":"tools"}. Need a stronger model: model.request_upgrade.`
      : "",
    "Use approval tools for customer sends, SSH changes and spending. Report pending approvals and stop. Never access mail/Square credentials, mark deals paid, publish listings or move money.",
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
  let checkpointLimit = input.preserveCheckpoint
    ? input.checkpointText.length
    : Math.min(5_000, input.checkpointText.length);
  let prompt = render(checkpointLimit);
  while (!input.preserveCheckpoint && bytes(prompt) > maxPromptBytes && checkpointLimit > 256) {
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

/** First runs must preserve every requirement; callers fall back to the configured worker if it does not fit. */
export function tryBuildCompactInitialTaskPrompt(
  input: Omit<CompactPromptInput, "checkpointText" | "preserveCheckpoint"> & {
    description?: string | null;
    continuation?: string | null;
  },
  finalize: (parts: string[]) => string,
): string | null {
  try {
    return buildCompactContextRolloverPrompt(
      {
        ...input,
        checkpointText: [
          input.description,
          input.departmentConstraint,
          input.departmentSharedPrompt,
          input.interruptPrompt,
          input.continuation,
        ]
          .filter(Boolean)
          .join("\n\n"),
        preserveCheckpoint: true,
        departmentConstraint: null,
        departmentSharedPrompt: null,
        interruptPrompt: null,
      },
      finalize,
    ).replace("[Durable checkpoint]", "[Task requirements]");
  } catch (error) {
    if (error instanceof Error && error.message === "context_rollover_prompt_exceeds_configured_window") return null;
    throw error;
  }
}
