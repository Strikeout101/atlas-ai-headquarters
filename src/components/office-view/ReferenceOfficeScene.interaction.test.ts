import { describe, expect, it, vi } from "vitest";
import type { OfficeViewProps } from "./model";
import { DESK_ANCHORS, INTERACTION_ANCHORS } from "./reference-map-geometry";

describe("reference office meeting interaction", () => {
  it("opens the active meeting minutes from the conference table", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { ReferenceOfficeScene } = await import("./ReferenceOfficeScene");
    const openMinutes = vi.fn();
    const scene = new ReferenceOfficeScene(
      document.createElement("div"),
      {
        activeMeetingTaskId: "meeting-42",
        onOpenActiveMeetingMinutes: openMinutes,
      } as unknown as OfficeViewProps,
      () => {},
      () => {},
    );
    Reflect.set(scene, "ceoPos", INTERACTION_ANCHORS.meetingTable);

    scene.interact();

    expect(openMinutes).toHaveBeenCalledOnce();
    expect(openMinutes).toHaveBeenCalledWith("meeting-42");
  });
});

describe("reference office floor selection", () => {
  it("selects a workstation where the lounge zone overlaps its chair", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { ReferenceOfficeScene } = await import("./ReferenceOfficeScene");
    const onObjectInteract = vi.fn();
    const scene = new ReferenceOfficeScene(
      document.createElement("div"),
      { agents: [], departments: [] } as unknown as OfficeViewProps,
      () => {},
      onObjectInteract,
    );
    const selectDesk = vi.spyOn(
      scene as unknown as { selectDeskDepartment: (index: number) => void },
      "selectDeskDepartment",
    );
    const desk = DESK_ANCHORS[2];

    Reflect.get(scene, "selectAt").call(scene, { x: desk.x, y: desk.y + 30 });

    expect(selectDesk).toHaveBeenCalledWith(2);
    expect(onObjectInteract).not.toHaveBeenCalled();
  });
});
