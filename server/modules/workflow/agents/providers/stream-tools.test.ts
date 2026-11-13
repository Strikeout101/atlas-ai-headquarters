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
