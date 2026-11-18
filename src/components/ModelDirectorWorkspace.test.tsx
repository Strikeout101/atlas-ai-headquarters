import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ModelDirectorWorkspace from "./ModelDirectorWorkspace";
import { getModelDirector, saveModelDirector } from "../api/model-routing";

vi.mock("../api/organization-projects", () => ({ getTasks: vi.fn(async () => []) }));
vi.mock("../api/model-routing", () => ({
  getModelDirector: vi.fn(),
  saveModelDirector: vi.fn(),
  getTaskModelRoute: vi.fn(),
  routeTaskModel: vi.fn(),
  decideModelUpgrade: vi.fn(),
}));

const config = {
  ok: true as const,
  directorAgentId: null,
  technicalDirectorAgentId: null,
  designDirectorAgentId: null,
  candidates: { codex: ["small", "strong"] },
  directors: [
    { id: "tech", name: "Technical lead", cli_provider: "codex" as const, status: "idle" },
    { id: "design", name: "Design lead", cli_provider: "claude" as const, status: "idle" },
  ],
  localRouting: {
    enabled: false,
    apiProviderId: null,
    model: null,
    taskTypes: ["documentation", "analysis"],
    contextWindowTokens: 8192,
  },
  localProviders: [{ id: "precision", name: "Precision", enabled: true, models: ["qwen-small"] }],
  performance: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getModelDirector).mockResolvedValue(structuredClone(config));
});

describe("model director controls", () => {
  it("persists separate directors and explicit local host, model, and task kinds", async () => {
    vi.mocked(saveModelDirector).mockResolvedValue(config);
    render(<ModelDirectorWorkspace />);
    fireEvent.change(await screen.findByLabelText("technical director"), { target: { value: "tech" } });
    fireEvent.change(screen.getByLabelText("design director"), { target: { value: "design" } });
    fireEvent.change(screen.getByLabelText("Ollama host"), { target: { value: "precision" } });
    fireEvent.change(screen.getByLabelText("Local model"), { target: { value: "qwen-small" } });
    fireEvent.click(screen.getByLabelText("Route selected routine tasks locally"));
    fireEvent.click(screen.getByLabelText("analysis"));
    fireEvent.change(screen.getByLabelText("Local context window (tokens)"), { target: { value: "4096" } });
    fireEvent.click(screen.getByRole("button", { name: "Save director settings" }));
    await waitFor(() =>
      expect(saveModelDirector).toHaveBeenCalledWith(
        expect.objectContaining({
          technicalDirectorAgentId: "tech",
          designDirectorAgentId: "design",
          localRouting: {
            enabled: true,
            apiProviderId: "precision",
            model: "qwen-small",
            taskTypes: ["documentation"],
            contextWindowTokens: 4096,
          },
        }),
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Director settings saved.");
  });

  it("clears the selected model when changing its host and shows validation errors", async () => {
    vi.mocked(getModelDirector).mockResolvedValue({
      ...config,
      localRouting: { ...config.localRouting, apiProviderId: "precision", model: "qwen-small" },
    });
    vi.mocked(saveModelDirector).mockRejectedValue(new Error("Choose a discovered Ollama model"));
    render(<ModelDirectorWorkspace />);
    fireEvent.change(await screen.findByLabelText("Ollama host"), { target: { value: "" } });
    expect(screen.getByLabelText("Local model")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Save director settings" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a discovered Ollama model");
  });

  it("shows honest unknown performance cost and repeat-attempt meaning", async () => {
    vi.mocked(getModelDirector).mockResolvedValue({
      ...config,
      performance: [
        {
          agent_id: "worker",
          provider: "api",
          model: "qwen",
          runs: 3,
          successes: 2,
          failures: 1,
          success_rate: 2 / 3,
          rework_runs: 1,
          cost_usd: null,
          cost_reported_runs: 0,
        },
      ],
    } as Awaited<ReturnType<typeof getModelDirector>>);
    render(<ModelDirectorWorkspace />);
    expect(await screen.findByText("Unknown")).toBeInTheDocument();
    expect(screen.getByText(/Success reflects worker exit codes/)).toHaveTextContent("including resumes");
    expect(screen.getByText("2/3")).toBeInTheDocument();
  });
});
