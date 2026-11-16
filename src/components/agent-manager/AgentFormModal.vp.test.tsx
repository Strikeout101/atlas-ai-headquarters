import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import AgentFormModal from "./AgentFormModal";
import { BLANK } from "./constants";

describe("VP agent editor", () => {
  it("locks provider, role and department for a VP", () => {
    render(
      <I18nProvider language="en">
        <AgentFormModal
          isKo={false}
          locale="en"
          tr={(_ko, en) => en}
          form={{ ...BLANK, name: "Codex VP", role: "vp", cli_provider: "codex" }}
          setForm={vi.fn()}
          departments={[]}
          isEdit
          saving={false}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(screen.getByRole("button", { name: "codex" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "claude" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Leader" })).toBeDisabled();
    expect(screen.getByRole("combobox")).toBeDisabled();
  });
  it("offers Codex or Claude as API worker fallback", () => {
    render(
      <I18nProvider language="en">
        <AgentFormModal
          isKo={false}
          locale="en"
          tr={(_ko, en) => en}
          form={{ ...BLANK, cli_provider: "api", cli_fallback_provider: "claude" }}
          setForm={vi.fn()}
          departments={[]}
          isEdit
          saving={false}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(screen.getByRole("combobox", { name: "CLI fallback after approval" })).toHaveValue("claude");
  });
});
