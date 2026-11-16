import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../i18n";
import { AutonomyToggle } from "./AgentFormModal";

function renderToggle(props: { isLeader: boolean; checked: boolean }) {
  const onChange = vi.fn();
  render(
    <I18nProvider language="en">
      <AutonomyToggle {...props} onChange={onChange} />
    </I18nProvider>,
  );
  return { onChange, toggle: screen.getByRole("switch", { name: "Suggests tasks" }) };
}

describe("AutonomyToggle", () => {
  it("is locked on for team leaders", async () => {
    const { onChange, toggle } = renderToggle({ isLeader: true, checked: true });
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();
    expect(screen.getByText(/Team leaders always suggest tasks/)).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("is an opt-in switch for everyone else", async () => {
    const { onChange, toggle } = renderToggle({ isLeader: false, checked: false });
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeEnabled();
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
