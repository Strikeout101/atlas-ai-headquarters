/**
 * What the office screens show, drawn into canvases that become the monitors' and the conference TV's textures.
 * Desk monitors are ultrawide (2.5:1); the TV is 16:9.
 */

export type ScreenState = "working" | "idle" | "away" | "off";

export interface DeskScreen {
  state: ScreenState;
  agentName?: string;
  taskTitle?: string | null;
  /** Latest terminal output of the agent's current task, oldest first. */
  lines?: string[];
}

export interface BoardData {
  agentsWorking: number;
  agentsTotal: number;
  inProgress: number;
  inReview: number;
  done: number;
  /** What agents are working on right now: agent name and task title. */
  active: Array<{ agent: string; task: string }>;
  meeting: string | null;
}

export const MONITOR_CANVAS = { width: 800, height: 320 } as const;
export const TV_CANVAS = { width: 1024, height: 576 } as const;

const MONO = '"Cascadia Code", "JetBrains Mono", Consolas, "SFMono-Regular", monospace';
const SANS = '"Inter", "Segoe UI", system-ui, sans-serif';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Terminal text -> the last `max` printable, non-empty lines (ANSI codes and control characters removed). */
export function cleanTerminalLines(text: string, max: number): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(ANSI, "").replace(/\t/g, "  ").trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-max);
}

function clock(now: Date): string {
  return now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fit(context: CanvasRenderingContext2D, text: string, width: number): string {
  if (context.measureText(text).width <= width) return text;
  let end = text.length;
  while (end > 0 && context.measureText(`${text.slice(0, end)}…`).width > width) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** A live terminal: title bar with the agent and task, then the newest output, with a blinking cursor. */
export function drawDeskScreen(context: CanvasRenderingContext2D, screen: DeskScreen, now: Date, cursorOn: boolean) {
  const { width: w, height: h } = MONITOR_CANVAS;
  context.fillStyle = "#06090d";
  context.fillRect(0, 0, w, h);
  if (screen.state === "off") return;

  if (screen.state === "away") {
    // Screensaver: dim clock.
    context.fillStyle = "#0b1016";
    context.fillRect(0, 0, w, h);
    context.font = `300 64px ${SANS}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = "#3d4a5c";
    context.fillText(clock(now), w / 2, h / 2 - 8);
    context.font = `500 18px ${SANS}`;
    context.fillStyle = "#2b3542";
    context.fillText("AWAY", w / 2, h / 2 + 44);
    context.textAlign = "left";
    return;
  }

  if (screen.state === "idle") {
    // Lit desktop, so idle monitors read as on from across the room.
    const gradient = context.createLinearGradient(0, 0, w, h);
    gradient.addColorStop(0, "#0f1f30");
    gradient.addColorStop(1, "#18344f");
    context.fillStyle = gradient;
    context.fillRect(0, 0, w, h);
    context.textBaseline = "middle";
    context.font = `400 18px ${SANS}`;
    context.fillStyle = "#8fb3d1";
    context.textAlign = "right";
    context.fillText(clock(now), w - 24, 30);
    context.textAlign = "left";
    context.font = `600 46px ${SANS}`;
    context.fillStyle = "#eaf2fa";
    context.fillText(fit(context, screen.agentName ?? "ATLAS", w - 80), 40, h * 0.42);
    context.font = `500 18px ${SANS}`;
    context.fillStyle = "#6fd3b0";
    context.fillText("●  READY FOR A TASK", 42, h * 0.6);
    context.font = `400 17px ${MONO}`;
    context.fillStyle = "#5f7d99";
    context.fillText("$", 42, h - 34);
    if (cursorOn) {
      context.fillStyle = "#a9c3db";
      context.fillRect(58, h - 43, 10, 18);
    }
    return;
  }

  // Window chrome.
  context.fillStyle = "#121a23";
  context.fillRect(0, 0, w, 34);
  ["#ff5f57", "#febc2e", "#28c840"].forEach((color, i) => {
    context.fillStyle = color;
    context.beginPath();
    context.arc(20 + i * 20, 17, 6, 0, Math.PI * 2);
    context.fill();
  });
  context.textBaseline = "middle";
  context.font = `600 16px ${SANS}`;
  context.fillStyle = "#c9d4e0";
  const title = screen.agentName ? `${screen.agentName.toLowerCase()}@atlas` : "atlas";
  context.fillText(title, 86, 17);
  context.font = `400 15px ${SANS}`;
  context.fillStyle = "#7b8a9c";
  context.textAlign = "right";
  context.fillText(clock(now), w - 16, 17);
  context.textAlign = "left";

  context.font = `400 17px ${MONO}`;
  const lineHeight = 22;
  const left = 16;
  const maxWidth = w - left * 2;
  let y = 34 + 18;

  // Working: task line, then the latest output.
  context.fillStyle = "#4fd1a5";
  context.fillText(fit(context, `▶ ${screen.taskTitle ?? "Working"}`, maxWidth), left, y);
  y += lineHeight + 4;
  const rows = Math.floor((h - y - 6) / lineHeight);
  const lines = (screen.lines?.length ? screen.lines : ["Starting…"]).slice(-rows);
  lines.forEach((line, i) => {
    const latest = i === lines.length - 1;
    context.fillStyle = /error|fail|✗|×/i.test(line) ? "#ff7b72" : latest ? "#e6edf3" : "#9fb0c2";
    context.fillText(fit(context, line, maxWidth - (latest ? 16 : 0)), left, y);
    if (latest && cursorOn) {
      const end = left + Math.min(context.measureText(line).width, maxWidth - 16) + 4;
      context.fillStyle = "#e6edf3";
      context.fillRect(end, y - 9, 10, 18);
    }
    y += lineHeight;
  });
}

/** The Director's own monitor: a welcome card that invites them to sit down. */
export function drawExecutiveScreen(context: CanvasRenderingContext2D, now: Date, working: number) {
  const { width: w, height: h } = MONITOR_CANVAS;
  const gradient = context.createLinearGradient(0, 0, w, h);
  gradient.addColorStop(0, "#0d1b2a");
  gradient.addColorStop(1, "#1b3550");
  context.fillStyle = gradient;
  context.fillRect(0, 0, w, h);
  context.textBaseline = "middle";
  context.textAlign = "center";
  context.font = `300 76px ${SANS}`;
  context.fillStyle = "#e8f1fa";
  context.fillText(clock(now), w / 2, h * 0.38);
  context.font = `500 20px ${SANS}`;
  context.fillStyle = "#8fb3d1";
  context.fillText(`ATLAS EXECUTIVE DESKTOP  ·  ${working} AGENT${working === 1 ? "" : "S"} WORKING`, w / 2, h * 0.66);
  context.textAlign = "left";
}

/** Conference room TV: the company board. */
export function drawBoard(context: CanvasRenderingContext2D, board: BoardData, now: Date) {
  const { width: w, height: h } = TV_CANVAS;
  const gradient = context.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, "#0b1420");
  gradient.addColorStop(1, "#101d2c");
  context.fillStyle = gradient;
  context.fillRect(0, 0, w, h);
  context.textBaseline = "middle";

  context.font = `600 30px ${SANS}`;
  context.fillStyle = "#f1f6fb";
  context.letterSpacing = "6px";
  context.fillText("ATLAS AI HQ", 48, 54);
  context.letterSpacing = "0px";
  context.fillStyle = "#38d7ff";
  context.fillRect(48, 78, 64, 3);
  context.font = `300 40px ${SANS}`;
  context.textAlign = "right";
  context.fillStyle = "#dbe7f3";
  context.fillText(clock(now), w - 48, 56);
  context.textAlign = "left";

  const stats: Array<[string, string, string]> = [
    [`${board.agentsWorking}/${board.agentsTotal}`, "Agents working", "#4fd1a5"],
    [String(board.inProgress), "In progress", "#38d7ff"],
    [String(board.inReview), "In review", "#f5b94a"],
    [String(board.done), "Done", "#a3b3c4"],
  ];
  const cardWidth = (w - 96 - 3 * 20) / 4;
  stats.forEach(([value, label, color], i) => {
    const x = 48 + i * (cardWidth + 20);
    context.fillStyle = "rgba(255, 255, 255, 0.05)";
    context.beginPath();
    context.roundRect(x, 112, cardWidth, 116, 14);
    context.fill();
    context.font = `600 46px ${SANS}`;
    context.fillStyle = color;
    context.fillText(value, x + 22, 158);
    context.font = `500 18px ${SANS}`;
    context.fillStyle = "#8da0b4";
    context.fillText(label.toUpperCase(), x + 22, 202);
  });

  let y = 278;
  if (board.meeting) {
    context.fillStyle = "rgba(56, 215, 255, 0.12)";
    context.beginPath();
    context.roundRect(48, y - 26, w - 96, 52, 12);
    context.fill();
    context.font = `600 20px ${SANS}`;
    context.fillStyle = "#38d7ff";
    context.fillText("● MEETING", 68, y);
    context.font = `500 21px ${SANS}`;
    context.fillStyle = "#e6f1fb";
    context.fillText(fit(context, board.meeting, w - 300), 200, y);
    y += 62;
  }
  context.font = `600 17px ${SANS}`;
  context.fillStyle = "#6f8397";
  context.letterSpacing = "3px";
  context.fillText("NOW WORKING ON", 48, y);
  context.letterSpacing = "0px";
  y += 38;
  const rows = board.active.slice(0, board.meeting ? 4 : 5);
  if (rows.length === 0) {
    context.font = `400 22px ${SANS}`;
    context.fillStyle = "#5d7084";
    context.fillText("Nobody is working on a task right now.", 48, y);
  }
  for (const row of rows) {
    context.fillStyle = "#4fd1a5";
    context.beginPath();
    context.arc(56, y, 5, 0, Math.PI * 2);
    context.fill();
    context.font = `600 22px ${SANS}`;
    context.fillStyle = "#eef4fa";
    context.fillText(fit(context, row.agent, 170), 76, y);
    context.font = `400 22px ${SANS}`;
    context.fillStyle = "#a9bacb";
    context.fillText(fit(context, row.task, w - 300), 260, y);
    y += 40;
  }
}
