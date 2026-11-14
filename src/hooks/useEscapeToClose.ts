import { useEffect, useRef } from "react";

/** Open windows that close on Escape, oldest first. Only the newest one closes per key press. */
const stack: Array<{ current: () => void }> = [];

/** True while any window using useEscapeToClose is open (other Escape handlers should then stand back). */
export function hasOpenEscapeLayer(): boolean {
  return stack.length > 0;
}

/** Escape in a field that already has typed text should never throw that text away. */
function isEditingText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return (target.textContent ?? "").trim().length > 0;
  if (target instanceof HTMLTextAreaElement) return target.value.length > 0;
  if (target instanceof HTMLInputElement) {
    const textLike = ["text", "search", "email", "url", "tel", "password", "number", ""].includes(target.type);
    return textLike && target.value.length > 0;
  }
  return false;
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.defaultPrevented || stack.length === 0) return;
  if (isEditingText(event.target)) return;
  event.preventDefault();
  stack[stack.length - 1].current();
}

/**
 * Closes a modal or panel when Escape is pressed. With several open, only the topmost closes, so stacked windows
 * peel off one at a time.
 */
export function useEscapeToClose(onClose: () => void, enabled = true): void {
  const handlerRef = useRef(onClose);
  handlerRef.current = onClose;

  useEffect(() => {
    if (!enabled) return;
    const entry = { current: () => handlerRef.current() };
    if (stack.length === 0) window.addEventListener("keydown", onKeyDown);
    stack.push(entry);
    return () => {
      const index = stack.indexOf(entry);
      if (index >= 0) stack.splice(index, 1);
      if (stack.length === 0) window.removeEventListener("keydown", onKeyDown);
    };
  }, [enabled]);
}
