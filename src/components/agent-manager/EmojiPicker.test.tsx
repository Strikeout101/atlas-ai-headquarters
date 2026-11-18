import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import EmojiPicker from "./EmojiPicker";

describe("EmojiPicker", () => {
  it("renders the group labels when opened", () => {
    const handleChange = vi.fn();

    render(<EmojiPicker tr={(en: string) => en} value="🤖" onChange={handleChange} />);

    fireEvent.click(screen.getByRole("button", { name: "🤖" }));

    expect(screen.getByText("Work")).toBeInTheDocument();
    expect(screen.getByText("People")).toBeInTheDocument();
    expect(screen.getByText("Objects")).toBeInTheDocument();
    expect(screen.getByText("Nature")).toBeInTheDocument();
  });
});
