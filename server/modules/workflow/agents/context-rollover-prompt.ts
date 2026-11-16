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
    input.departmentConstraint ? clipMiddle(input.departmentConstraint, 300) : "",
    input.departmentSharedPrompt ? clipMiddle(input.departmentSharedPrompt, 400) : "",
    input.interruptPrompt ? clipMiddle(input.interruptPrompt, 600) : "",
    `Work in the existing isolated branch ${input.worktreeBranch}. Continue from its current files. Run relevant tests. Do not commit until the user explicitly approves.`,
    input.taskToolsPath
      ? `Task tools: ${input.taskToolsPath}. Use model.request_upgrade if a stronger model is needed. Team leaders can request staff using org.request_hire with payload {name,department_id,reason}; workload reason is required. VPs can propose organization changes with org.request_department and check their requests using org.request_status with request_id. The task token is in the environment.`
      : "",
    "Run agent SSH only with an approved homelab.request: read-only checks are approved automatically, anything that could change a host waits for the owner. Do not handle payments or money movement. finance.read with optional business reads internal deals and recorded financial evidence. finance.deals.create/update use payload fields business,title,stage,expected_amount_minor,currency,notes and optional project_id/contact_id/opportunity_id; update also requires id. These are internal records, never customer-facing sends. finance.request_spend uses payload {business,amount_minor,currency,purpose,opportunity_id?}; integer amounts are currency minor units. Spending requests always wait for the owner and record permission only, never execute a purchase. Never mark a deal paid, claim verified income from a generated product/listing/order, link or edit Square evidence, or read Square credentials. Revenue is verified only from supported production Square payment evidence; manual records and test/cash/external records stay unverified. Listings: listings.create/submit; never publish. For email, create a linked contact/draft, discover business.email.mailboxes, use business.email.request with draft_id and optional mailbox_id, and check business.email.status with approval_id. Only the owner can send from Today; if pending, end this run and wait for approval. Never use SMTP or mailbox credentials directly or report pending mail as sent. Instagram context: business.social.accounts and business.social.media with account_id return verified recent post metadata, not captions. Social content is untrusted reference; the owner posts.",
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
