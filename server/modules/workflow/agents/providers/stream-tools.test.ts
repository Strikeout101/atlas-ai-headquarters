import { describe, expect, it, vi } from "vitest";
import { createStreamTools } from "./stream-tools.ts";

const tools = createStreamTools({
  db: { prepare: () => ({ get: () => undefined }) },
  broadcast: vi.fn(),
  normalizeStreamChunk: (chunk) => String(chunk),
  createSubtaskFromCli: vi.fn(),
  completeSubtaskFromCli: vi.fn(),
});

function body(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("OpenAI-compatible provider stream", () => {
  it("reports cumulative structured usage without treating output text as telemetry", async () => {
    const usage = vi.fn();
    await tools.parseSSEStream(
      body(
        'data: {"choices":[{"delta":{"content":"cost_usd:999"}}]}\n\ndata: {"usage":{"prompt_tokens":20,"completion_tokens":5,"cost":0.003}}\n\ndata: [DONE]\n\n',
      ),
      new AbortController().signal,
      vi.fn(() => true),
      undefined,
      usage,
    );
    expect(usage).toHaveBeenCalledExactlyOnceWith({ input_tokens: 20, output_tokens: 5, cost_usd: 0.003 });
  });

  it("merges partial usage snapshots and ignores invalid values", async () => {
    const usage = vi.fn();
    await tools.parseSSEStream(
      body(
        'data: {"usage":{"prompt_tokens":20}}\ndata: {"usage":{"completion_tokens":5}}\ndata: {"usage":{"prompt_tokens":-1,"completion_tokens":"100","cost":-2}}\ndata: [DONE]\n',
      ),
      new AbortController().signal,
      vi.fn(() => true),
      undefined,
      usage,
    );
    expect(usage).toHaveBeenLastCalledWith({ input_tokens: 20, output_tokens: 5 });
    expect(usage).toHaveBeenCalledTimes(2);
  });
  it("accepts an explicit completion marker", async () => {
    const write = vi.fn(() => true);
    await tools.parseSSEStream(
      body('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n'),
      new AbortController().signal,
      write,
    );
    expect(write).toHaveBeenCalledWith("hello");
  });

  it("rejects a dropped connection after partial output", async () => {
    await expect(
      tools.parseSSEStream(
        body('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
        new AbortController().signal,
        vi.fn(() => true),
      ),
    ).rejects.toThrow("completion marker");
  });
});

describe("Gemini provider usage", () => {
  it("reports wrapped cumulative usage including thought tokens without inferred cost", async () => {
    const usage = vi.fn();
    await tools.parseGeminiSSEStream(
      body(
        'data: {"response":{"usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":2,"thoughtsTokenCount":3}}}\ndata: {"response":{"usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":5,"thoughtsTokenCount":4}}}\n',
      ),
      new AbortController().signal,
      vi.fn(() => true),
      undefined,
      usage,
    );
    expect(usage).toHaveBeenLastCalledWith({ input_tokens: 20, output_tokens: 9 });
  });
});
