import { describe, expect, it } from "vitest";
import { prettyStreamJson } from "./pretty-stream-json.ts";

const lines = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");

describe("Claude stream result normalization", () => {
  it("returns one parseable JSON value when streaming, assistant and result repeat it", () => {
    const text = '{"verdict":"approve","reason":"Bounded internal work"}';
    const output = prettyStreamJson(
      lines(
        { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } },
        { type: "assistant", message: { content: [{ type: "text", text }] } },
        { type: "result", result: text },
      ),
    );
    expect(output).toBe(text);
    expect(JSON.parse(output).verdict).toBe("approve");
  });

  it("deduplicates a non-streamed assistant message and its result", () => {
    const text = '{"ready":true}';
    expect(
      prettyStreamJson(
        lines({ type: "assistant", message: { content: [{ type: "text", text }] } }, { type: "result", result: text }),
      ),
    ).toBe(text);
  });

  it("preserves result-only responses", () => {
    expect(prettyStreamJson(lines({ type: "result", result: '{"ready":true}' }))).toBe('{"ready":true}');
  });

  it("does not duplicate text supplied at content block start", () => {
    const text = '{"ready":true}';
    expect(
      prettyStreamJson(
        lines(
          { type: "stream_event", event: { type: "content_block_start", content_block: { type: "text", text } } },
          { type: "assistant", message: { content: [{ type: "text", text }] } },
          { type: "result", result: text },
        ),
      ),
    ).toBe(text);
  });

  it("preserves Codex assistant output and plain text", () => {
    expect(prettyStreamJson(lines({ type: "item.completed", item: { type: "agent_message", text: "Done" } }))).toBe(
      "Done",
    );
    expect(prettyStreamJson("plain text")).toBe("plain text");
  });
});
