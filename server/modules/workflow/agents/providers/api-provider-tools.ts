import fs from "node:fs";
import { createRunPerformanceTracker } from "../../../agent-performance.ts";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { decryptSecret } from "../../../../oauth/helpers.ts";
import type { ApiProviderRow } from "./types.ts";
import {
  createProviderUsageReporter,
  IncompleteProviderStreamError,
  type ProviderUsageCallback,
} from "./stream-tools.ts";
import { getCurrentTaskModelRoute } from "../../../model-routing.ts";
import { createOpenCodeContextMonitor } from "./opencode-context-monitor.ts";
import { setContextRolloverProcessPid } from "../context-rollover-store.ts";
import { autonomyTaskUsageBlockReason } from "../../../autonomy-engine.ts";
import { assertRunsAllowed, automaticStartBlockReason } from "../../../control-state.ts";

class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

type DbLike = {
  prepare: (sql: string) => {
    get: (...args: any[]) => unknown;
  };
};

type CreateApiProviderToolsDeps = {
  db: DbLike;
  logsDir: string;
  activeProcesses: Map<string, ChildProcess>;
  broadcast: (event: string, payload: unknown) => void;
  normalizeStreamChunk: (raw: Buffer | string, opts?: { dropCliNoise?: boolean }) => string;
  handleTaskRunComplete: (
    taskId: string,
    exitCode: number,
    failureKind?: "provider_unavailable" | "worker_interrupted" | "context_exhausted" | "context_near_limit",
  ) => void;
  spawnCliAgent: (
    taskId: string,
    provider: string,
    prompt: string,
    projectPath: string,
    logPath: string,
    model?: string,
    reasoningLevel?: string,
    extraEnv?: Record<string, string>,
    onRawOutput?: (chunk: Buffer, stream: "stdout" | "stderr") => void,
  ) => ChildProcess;
  killPidTree?: (pid: number) => void;
  createSafeLogStreamOps: (logStream: any) => {
    safeWrite: (text: string) => boolean;
    safeEnd: (onDone?: () => void) => void;
    isClosed: () => boolean;
  };
  parseSSEStream: (
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    safeWrite: (text: string) => boolean,
    taskId?: string,
    onUsage?: ProviderUsageCallback,
  ) => Promise<void>;
  parseGeminiSSEStream: (
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    safeWrite: (text: string) => boolean,
    taskId?: string,
    onUsage?: ProviderUsageCallback,
  ) => Promise<void>;
};

export function createApiProviderTools(deps: CreateApiProviderToolsDeps) {
  const {
    db,
    logsDir,
    activeProcesses,
    broadcast,
    normalizeStreamChunk,
    handleTaskRunComplete,
    spawnCliAgent,
    killPidTree,
    createSafeLogStreamOps,
    parseSSEStream,
    parseGeminiSSEStream,
  } = deps;

  async function parseAnthropicSSEStream(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    safeWrite: (text: string) => boolean,
    taskId?: string,
    onUsage?: ProviderUsageCallback,
  ): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    const reportUsage = createProviderUsageReporter(onUsage);

    const processLine = (trimmed: string) => {
      if (!trimmed || trimmed.startsWith(":")) return;
      if (!trimmed.startsWith("data: ")) return;
      if (trimmed === "data: [DONE]") return;
      try {
        const data = JSON.parse(trimmed.slice(6));
        const usage = data.message?.usage ?? data.usage;
        if (usage) reportUsage({ input_tokens: usage.input_tokens, output_tokens: usage.output_tokens });
        if (data.type === "content_block_delta" && data.delta?.text) {
          const text = normalizeStreamChunk(data.delta.text);
          if (!text) return;
          safeWrite(text);
          if (taskId) {
            broadcast("cli_output", { task_id: taskId, stream: "stdout", data: text });
          }
        }
      } catch {
        /* ignore */
      }
    };

    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      if (signal.aborted) break;
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line.trim());
    }
    if (buffer.trim()) processLine(buffer.trim());
  }

  function getApiProviderById(providerId: string): ApiProviderRow | null {
    return (
      (db.prepare("SELECT * FROM api_providers WHERE id = ?").get(providerId) as unknown as ApiProviderRow) ?? null
    );
  }

  function resolveApiProviderModel(provider: ApiProviderRow, requestedModel: string | null): string {
    if (requestedModel) return requestedModel;
    if (provider.models_cache) {
      try {
        const models = JSON.parse(provider.models_cache) as string[];
        if (models.length > 0) return models[0];
      } catch {
        /* ignore */
      }
    }
    throw new Error(
      `No model specified for API provider '${provider.name}'. ` +
        `Please select a model in the agent settings or run a connection test first to cache available models.`,
    );
  }

  function normalizeApiBaseUrl(rawUrl: string): string {
    let url = rawUrl.replace(/\/+$/, "");
    url = url.replace(/\/(v\d+)\/(chat\/completions|models|messages)$/i, "/$1");
    url = url.replace(/\/v1beta\/models\/.+$/i, "/v1beta");
    return url;
  }

  function buildApiProviderRequest(
    provider: ApiProviderRow,
    model: string,
    prompt: string,
    projectPath: string,
  ): { url: string; headers: Record<string, string>; body: string } {
    const apiKey = provider.api_key_enc ? decryptSecret(provider.api_key_enc) : "";
    const baseUrl = normalizeApiBaseUrl(provider.base_url);

    if (provider.type === "anthropic") {
      const messagesUrl = baseUrl.endsWith("/v1") ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`;
      return {
        url: messagesUrl,
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 16384,
          stream: true,
          messages: [{ role: "user", content: prompt }],
          system: `You are a coding assistant. Project path: ${projectPath}`,
        }),
      };
    }

    if (provider.type === "google") {
      const googleBase = baseUrl.endsWith("/v1beta") ? baseUrl : `${baseUrl}/v1beta`;
      const url = `${googleBase}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
      return {
        url,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          systemInstruction: { parts: [{ text: `You are a coding assistant. Project path: ${projectPath}` }] },
        }),
      };
    }

    const chatUrl = /\/v\d+$/.test(baseUrl) ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    if (provider.type === "openrouter") {
      headers["HTTP-Referer"] = "https://claw-empire.app";
      headers["X-Title"] = "Claw-Empire";
    }

    return {
      url: chatUrl,
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: `You are a coding assistant. Project path: ${projectPath}` },
          { role: "user", content: prompt },
        ],
        stream: true,
        stream_options: { include_usage: true },
      }),
    };
  }

  async function executeApiProviderAgent(
    prompt: string,
    projectPath: string,
    logStream: fs.WriteStream,
    signal: AbortSignal,
    taskId?: string,
    apiProviderId?: string | null,
    apiModel?: string | null,
    safeWriteOverride?: (text: string) => boolean,
    onUsage?: ProviderUsageCallback,
  ): Promise<void> {
    const safeWrite = safeWriteOverride ?? createSafeLogStreamOps(logStream).safeWrite;

    if (!apiProviderId) {
      throw new Error("No API provider configured for this agent. Set api_provider_id first.");
    }

    const provider = getApiProviderById(apiProviderId);
    if (!provider) {
      throw new Error(`API provider not found: ${apiProviderId}`);
    }
    if (!provider.enabled) {
      throw new Error(`API provider '${provider.name}' is disabled.`);
    }

    const model = resolveApiProviderModel(provider, apiModel ?? null);
    const header = `[api:${provider.type}] Provider: ${provider.name}, Model: ${model}\n---\n`;
    safeWrite(header);
    if (taskId) broadcast("cli_output", { task_id: taskId, stream: "stderr", data: header });

    const req = buildApiProviderRequest(provider, model, prompt, projectPath);

    let resp: Response;
    try {
      resp = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new ProviderUnavailableError(`API provider '${provider.name}' could not be reached: ${String(err)}`);
    }

    if (!resp.ok) {
      const text = await resp.text();
      const message = `API provider '${provider.name}' error (${resp.status}): ${text}`;
      if (resp.status === 408 || resp.status === 429 || resp.status >= 500) {
        throw new ProviderUnavailableError(message);
      }
      throw new Error(message);
    }

    if (!resp.body) throw new ProviderUnavailableError(`API provider '${provider.name}' returned no stream`);

    if (provider.type === "anthropic") {
      await parseAnthropicSSEStream(resp.body, signal, safeWrite, taskId, onUsage);
    } else if (provider.type === "google") {
      await parseGeminiSSEStream(resp.body, signal, safeWrite, taskId, onUsage);
    } else {
      await parseSSEStream(resp.body, signal, safeWrite, taskId, onUsage);
    }

    safeWrite(`\n---\n[api:${provider.type}] Done.\n`);
    if (taskId) {
      broadcast("cli_output", { task_id: taskId, stream: "stderr", data: `\n---\n[api:${provider.type}] Done.\n` });
    }
  }

  function launchApiProviderAgent(
    taskId: string,
    apiProviderId: string | null,
    apiModel: string | null,
    prompt: string,
    projectPath: string,
    logPath: string,
    controller: AbortController,
    fakePid: number,
    onComplete?: (exitCode: number) => void,
  ): void {
    assertRunsAllowed();
    const autonomyBlock =
      automaticStartBlockReason(db as any, taskId) || autonomyTaskUsageBlockReason(db as any, taskId);
    if (autonomyBlock) throw new Error(autonomyBlock);
    const taskRoute = getCurrentTaskModelRoute(db as any, taskId);
    if (taskRoute?.provider === "api") {
      apiProviderId = taskRoute.api_provider_id ?? apiProviderId;
      apiModel = taskRoute.model;
    }
    const provider = apiProviderId ? getApiProviderById(apiProviderId) : null;
    if (provider?.type === "ollama" && provider.enabled) {
      // Ollama's API chat path only emits text. Run coding tasks through the
      // existing OpenCode worktree runner so the model gets file and shell tools.
      let model: string;
      try {
        model = resolveApiProviderModel(provider, apiModel);
        if (!/^[A-Za-z0-9._:/-]+$/.test(model)) throw new Error("Invalid model ID for CLI execution");
      } catch {
        if (onComplete) onComplete(1);
        else handleTaskRunComplete(taskId, 1);
        return;
      }
      const providerKey = `climpire-${provider.id.replace(/[^a-zA-Z0-9-]/g, "-")}`;
      const settings: Record<string, string> = { baseURL: normalizeApiBaseUrl(provider.base_url) };
      if (provider.api_key_enc) settings.apiKey = decryptSecret(provider.api_key_enc);
      const config = {
        $schema: "https://opencode.ai/config.json",
        // ATLAS preserves the isolated worktree itself. Avoid a second snapshot
        // scan of the project before every small local-model run.
        snapshots: false,
        providers: {
          [providerKey]: {
            name: provider.name,
            package: "@opencode/ai/providers/openai-compatible",
            settings,
            models: { [model]: { name: model } },
          },
        },
        permissions: [
          { action: "shell", resource: "*", effect: "allow" },
          { action: "shell", resource: "git commit *", effect: "deny" },
          { action: "shell", resource: "git push *", effect: "deny" },
        ],
      };
      let child: ChildProcess;
      const agentConfig = db
        .prepare(
          "SELECT a.context_window_tokens FROM tasks t JOIN agents a ON a.id = t.assigned_agent_id WHERE t.id = ?",
        )
        .get(taskId) as { context_window_tokens?: number | null } | undefined;
      const monitor = createOpenCodeContextMonitor({
        contextWindowTokens: taskRoute?.context_window_tokens ?? agentConfig?.context_window_tokens,
        onNearLimit: () => {
          if (child?.pid && killPidTree) killPidTree(child.pid);
          else child?.kill("SIGINT");
        },
      });
      try {
        child = spawnCliAgent(
          taskId,
          "opencode",
          prompt,
          projectPath,
          logPath,
          `${providerKey}/${model}`,
          undefined,
          { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
          (chunk, stream) => monitor.ingest(chunk, stream),
        );
      } catch {
        if (onComplete) onComplete(1);
        else handleTaskRunComplete(taskId, 1, "provider_unavailable");
        return;
      }
      if (child.pid && child.pid > 0) {
        try {
          setContextRolloverProcessPid(db as any, taskId, child.pid, Date.now());
        } catch {
          /* Optional schema in isolated tests. */
        }
      }
      const onAbort = () => child.kill();
      controller.signal.addEventListener("abort", onAbort, { once: true });
      child.once("close", async (code) => {
        controller.signal.removeEventListener("abort", onAbort);
        monitor.finish();
        // A late close from an older run must not complete or clear its replacement.
        const currentProcess = activeProcesses.get(taskId);
        if (currentProcess && currentProcess !== child) return;
        const exitCode = code ?? 1;
        if (onComplete) onComplete(exitCode);
        else if (monitor.reason === "near_limit") handleTaskRunComplete(taskId, exitCode || 1, "context_near_limit");
        else if (monitor.reason === "context_exhausted" && exitCode !== 0)
          handleTaskRunComplete(taskId, exitCode, "context_exhausted");
        else if (exitCode === 0) handleTaskRunComplete(taskId, 0);
        else {
          let kind: "provider_unavailable" | "worker_interrupted" = "worker_interrupted";
          try {
            const health = await fetch(`${normalizeApiBaseUrl(provider.base_url)}/models`, {
              signal: AbortSignal.timeout(2500),
            });
            if (!health.ok) kind = "provider_unavailable";
          } catch {
            kind = "provider_unavailable";
          }
          handleTaskRunComplete(taskId, exitCode, kind);
        }
      });
      return;
    }

    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    const { safeWrite, safeEnd } = createSafeLogStreamOps(logStream);
    safeWrite(`\n===== task run start ${new Date().toISOString()} | provider=api =====\n`);

    const promptPath = path.join(logsDir, `${taskId}.prompt.txt`);
    fs.writeFileSync(promptPath, prompt, "utf8");

    const mockProc = {
      pid: fakePid,
      kill: () => {
        controller.abort();
        return true;
      },
    } as unknown as ChildProcess;
    activeProcesses.set(taskId, mockProc);

    if (provider) {
      try {
        apiModel = resolveApiProviderModel(provider, apiModel);
      } catch {
        /* execution reports invalid configuration below */
      }
    }
    const performance = createRunPerformanceTracker(db as any, taskId, { provider: "api", model: apiModel });
    const runTask = (async () => {
      let exitCode = 0;
      let failureKind: "provider_unavailable" | undefined;
      try {
        await executeApiProviderAgent(
          prompt,
          projectPath,
          logStream,
          controller.signal,
          taskId,
          apiProviderId,
          apiModel,
          safeWrite,
          (usage) =>
            performance.ingest(`${JSON.stringify({ type: "result", usage, total_cost_usd: usage.cost_usd })}\n`),
        );
      } catch (err: any) {
        exitCode = 1;
        if (
          !controller.signal.aborted &&
          (err instanceof ProviderUnavailableError ||
            err instanceof IncompleteProviderStreamError ||
            err instanceof TypeError)
        ) {
          failureKind = "provider_unavailable";
        }
        if (err.name !== "AbortError") {
          const msg = normalizeStreamChunk(`[api] Error: ${err.message}\n`);
          safeWrite(msg);
          broadcast("cli_output", { task_id: taskId, stream: "stderr", data: msg });
          console.error(`[Claw-Empire] API provider agent error (task ${taskId}): ${err.message}`);
        } else {
          const msg = normalizeStreamChunk(`[api] Aborted by user\n`);
          safeWrite(msg);
          broadcast("cli_output", { task_id: taskId, stream: "stderr", data: msg });
        }
      } finally {
        performance.finish(exitCode, controller.signal.aborted);
        await new Promise<void>((resolve) => safeEnd(resolve));
        try {
          fs.unlinkSync(promptPath);
        } catch {
          /* ignore */
        }
        if (onComplete) {
          onComplete(exitCode);
        } else {
          handleTaskRunComplete(taskId, exitCode, failureKind);
        }
      }
    })();

    runTask.catch(() => {});
  }

  return {
    executeApiProviderAgent,
    launchApiProviderAgent,
  };
}
