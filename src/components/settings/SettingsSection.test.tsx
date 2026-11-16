import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import SettingsSection from "./SettingsSection";

function Editor() {
  const [value, setValue] = useState("");
  return (
    <SettingsSection title="Account settings" defaultOpen>
      <label>
        Display name
        <input value={value} onChange={(event) => setValue(event.target.value)} />
      </label>
    </SettingsSection>
  );
}

describe("SettingsSection", () => {
  it("preserves unsaved form values when collapsed and reopened", async () => {
    const user = userEvent.setup();
    render(<Editor />);
    const input = screen.getByLabelText("Display name");
    await user.type(input, "Saved locally until submit");
    const summary = screen.getByText("Account settings");
    const details = summary.closest("details")!;
    await user.click(summary);
    await waitFor(() => expect(details).not.toHaveAttribute("open"));
    expect(input).toBeInTheDocument();
    await user.click(summary);
    await waitFor(() => expect(details).toHaveAttribute("open"));
    expect(input).toHaveValue("Saved locally until submit");
  });
});
