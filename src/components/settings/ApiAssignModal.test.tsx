import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApiStateBundle } from "./types";
import ApiAssignModal from "./ApiAssignModal";
import { DEFAULT_API_FORM } from "./useApiProvidersState";

vi.mock("../AgentAvatar", () => ({
  default: () => <div>avatar</div>,
  buildSpriteMap: () => ({}),
}));

function t(messages: Record<string, string>): string {
  return messages.en ?? messages.ko ?? messages.ja ?? messages.zh ?? Object.values(messages)[0] ?? "";
}

function makeApiState(): ApiStateBundle {
  return {
    apiProviders: [],
    apiProvidersLoading: false,
    apiOfficialPresets: {},
    apiPresetsLoading: false,
    apiAddMode: false,
    apiEditingId: null,
    apiForm: DEFAULT_API_FORM,
    apiSaving: false,
    apiSaveError: null,
    apiTesting: null,
    apiTestResult: {},
    apiModelsExpanded: {},
    apiAssignTarget: { providerId: "provider-1", model: "gpt-4o" },
    contextWindowTokensInput: "",
    apiAssignAgents: [
      {
        id: "agent-dev",
        name: "Dev Lead",
        name_ko: "개발 리드",
        department_id: "planning",
        role: "team_leader",
        cli_provider: "claude",
        avatar_emoji: "A",
        personality: null,
        status: "idle",
        current_task_id: null,
        stats_tasks_done: 0,
        stats_xp: 0,
        created_at: 1,
      },
      {
        id: "agent-video",
        name: "Design Lead",
        name_ko: "디자인 리드",
        department_id: null,
        role: "team_leader",
        cli_provider: "claude",
        avatar_emoji: "B",
        personality: null,
        status: "idle",
        current_task_id: null,
        stats_tasks_done: 0,
        stats_xp: 0,
        created_at: 2,
      },
    ],
    apiAssignDepts: [
      {
        id: "planning",
        name: "Planning",
        name_ko: "기획",
        icon: "P",
        color: "#000000",
        description: null,
        prompt: null,
        sort_order: 0,
        created_at: 1,
      },
    ],
    apiAssigning: false,
    setApiAddMode: vi.fn(),
    setApiEditingId: vi.fn(),
    setApiForm: vi.fn(),
    setApiSaveError: vi.fn(),
    setApiModelsExpanded: vi.fn(),
    setApiAssignTarget: vi.fn(),
    setContextWindowTokensInput: vi.fn(),
    loadApiProviders: vi.fn(),
    loadApiPresets: vi.fn(),
    handleApiProviderSave: vi.fn(),
    handleApiProviderDelete: vi.fn(),
    handleApiProviderTest: vi.fn(),
    handleApiProviderToggle: vi.fn(),
    handleApiEditStart: vi.fn(),
    handleApiModelAssign: vi.fn(),
    handleApiAssignToAgent: vi.fn(),
  };
}

describe("ApiAssignModal", () => {
  it("groups agents by department and lists the rest as unassigned", () => {
    render(<ApiAssignModal t={t} localeTag="en-US" apiState={makeApiState()} />);

    expect(screen.getByText("Planning")).toBeInTheDocument();
    expect(screen.getByText("Dev Lead")).toBeInTheDocument();
    expect(screen.getByText("Unassigned")).toBeInTheDocument();
    expect(screen.getByText("Design Lead")).toBeInTheDocument();
    expect(screen.queryByText("Development Office")).not.toBeInTheDocument();
  });

  it("shows the context window setting for Ollama assignments", () => {
    const state = makeApiState();
    state.apiProviders = [{ id: "provider-1", type: "ollama" } as ApiStateBundle["apiProviders"][number]];
    state.apiAssignTarget = { providerId: "provider-1", model: "qwen" };
    state.contextWindowTokensInput = "8192";
    render(<ApiAssignModal t={t} localeTag="en-US" apiState={state} />);

    expect(screen.getByLabelText("Context window (tokens)")).toHaveValue(8192);
    expect(screen.getByText(/Roll over at 80%/)).toBeInTheDocument();
  });
});
