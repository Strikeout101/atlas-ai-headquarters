import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { hasOpenEscapeLayer, useEscapeToClose } from "./useEscapeToClose";

function Layer({ onClose, withInput = false }: { onClose: () => void; withInput?: boolean }) {
  useEscapeToClose(onClose);
  return withInput ? <input aria-label="field" defaultValue="" /> : <div />;
}

describe("useEscapeToClose", () => {
  it("closes only the topmost window per Escape press", () => {
    const bottom = vi.fn();
    const top = vi.fn();
    const { unmount } = render(
      <>
        <Layer onClose={bottom} />
        <Layer onClose={top} />
      </>,
    );
    expect(hasOpenEscapeLayer()).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(top).toHaveBeenCalledTimes(1);
    expect(bottom).not.toHaveBeenCalled();
    unmount();
    expect(hasOpenEscapeLayer()).toBe(false);
  });

  it("leaves the window open while the cursor is in a field with typed text", () => {
    const onClose = vi.fn();
    const { getByLabelText } = render(<Layer onClose={onClose} withInput />);
    const input = getByLabelText("field") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "half-written reply" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
