/**
 * Decides whether an agent's SSH command is read-only enough to run without the owner's approval.
 *
 * This is an allowlist, not a denylist: a command is auto-approved only when every part of it is a known
 * read-only program with read-only arguments. Anything unknown, any shell feature that could hide a second
 * command or write a file, and any read of secret material goes to the owner instead.
 */

export interface SshCommandVerdict {
  readOnly: boolean;
  /** Short machine-readable reason when the command needs approval. */
  reason?: string;
}

/** Shell features that can chain commands, substitute output, write files or run in the background. */
const FORBIDDEN_SHELL = /[;&`$<>\n\r\\(){}]|\|\|/;

/** Paths whose contents are secrets; reading them still needs the owner. */
const SECRET_PATH =
  /(\/etc\/(g?shadow|sudoers)|\/\.ssh\/|id_(rsa|ecdsa|ed25519|dsa)|\.pem\b|\.key\b|\/etc\/ssl\/private|(^|\/)\.env\b|\/etc\/pve\/priv|passwd-|credentials|secrets?\b|token)/i;

type ArgRule = (args: string[]) => boolean;

const any: ArgRule = () => true;
const firstArgIn =
  (...allowed: string[]): ArgRule =>
  (args) => {
    const sub = args.find((a) => !a.startsWith("-"));
    return sub !== undefined && allowed.includes(sub);
  };
const noFlags =
  (...blocked: string[]): ArgRule =>
  (args) =>
    !args.some((a) => blocked.some((b) => a === b || a.startsWith(`${b}=`)));

const RULES: Record<string, ArgRule> = {
  // System and hardware
  uptime: any,
  hostname: (args) => args.every((a) => a.startsWith("-")),
  whoami: any,
  id: any,
  date: (args) => !args.some((a) => a === "-s" || a.startsWith("--set")),
  uname: any,
  free: any,
  vmstat: any,
  iostat: any,
  lscpu: any,
  lsblk: any,
  lsusb: any,
  lspci: any,
  lsmod: any,
  sensors: any,
  nproc: any,
  ps: any,
  pgrep: any,
  top: (args) => args.includes("-b"),
  df: any,
  du: any,
  mount: (args) => args.length === 0 || args.every((a) => a === "-l"),
  findmnt: any,
  // Files (read only)
  ls: any,
  stat: any,
  cat: any,
  head: any,
  tail: any,
  wc: any,
  grep: any,
  egrep: any,
  zgrep: any,
  cut: any,
  file: any,
  readlink: any,
  realpath: any,
  find: noFlags("-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"),
  // Network
  ip: (args) => {
    const sub = args.find((a) => !a.startsWith("-"));
    const verb = args.filter((a) => !a.startsWith("-"))[1];
    const objects = ["a", "addr", "address", "r", "route", "l", "link", "n", "neigh", "rule"];
    return (
      sub !== undefined && objects.includes(sub) && (verb === undefined || ["show", "list", "ls", "get"].includes(verb))
    );
  },
  ss: any,
  netstat: any,
  ping: (args) => args.includes("-c"),
  dig: any,
  nslookup: any,
  host: any,
  traceroute: any,
  // Services and logs
  systemctl: firstArgIn(
    "status",
    "is-active",
    "is-enabled",
    "is-failed",
    "list-units",
    "list-unit-files",
    "list-timers",
    "list-sockets",
    "show",
    "cat",
  ),
  journalctl: noFlags(
    "--vacuum-size",
    "--vacuum-time",
    "--vacuum-files",
    "--rotate",
    "--flush",
    "--sync",
    "--relinquish-var",
    "--setup-keys",
  ),
  // Containers and Proxmox
  docker: (args) => {
    const sub = args.find((a) => !a.startsWith("-"));
    if (sub === "stats") return args.includes("--no-stream");
    return sub !== undefined && ["ps", "images", "logs", "inspect", "version", "info", "top", "port"].includes(sub);
  },
  pct: firstArgIn("list", "status", "config", "listsnapshot"),
  qm: firstArgIn("list", "status", "config", "listsnapshot", "pending"),
  pvesm: firstArgIn("status", "list"),
  pvesh: firstArgIn("get", "ls"),
  pveversion: any,
  zpool: firstArgIn("status", "list", "iostat"),
  zfs: firstArgIn("list", "get"),
  smartctl: (args) =>
    args.every((a) => !a.startsWith("-") || ["-a", "-H", "-i", "-x", "-A", "--all", "--health", "--info"].includes(a)),
  // Packages (queries only)
  dpkg: (args) =>
    args.every((a) => !a.startsWith("-") || ["-l", "-L", "-s", "--list", "--status", "--listfiles"].includes(a)),
  apt: firstArgIn("list", "show", "policy", "search"),
  "apt-cache": firstArgIn("policy", "show", "search", "depends", "rdepends"),
  pihole: firstArgIn("status", "-v", "version"),
};

/** Splits a command into words, honouring simple single and double quotes. Returns null if quoting is unbalanced. */
function words(segment: string): string[] | null {
  // Anything other than whole-word quoting (odd counts, quotes glued to text) is left for the owner.
  const token = String.raw`(?:"[^"]*"|'[^']*'|[^\s"']+)`;
  if (!new RegExp(String.raw`^\s*(?:${token}(?:\s+${token})*)?\s*$`).test(segment)) return null;
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|([^\s"']+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(segment))) out.push(match[1] ?? match[2] ?? match[3]);
  return out;
}

function checkSegment(segment: string): SshCommandVerdict {
  const parts = words(segment.trim());
  if (!parts || parts.length === 0) return { readOnly: false, reason: "unparsed" };
  let [program, ...args] = parts;
  if (program === "sudo") {
    if (args[0]?.startsWith("-")) return { readOnly: false, reason: "sudo_options" };
    [program, ...args] = args;
    if (!program) return { readOnly: false, reason: "unparsed" };
  }
  if (program.includes("/") || program.includes("=")) return { readOnly: false, reason: "program_path_or_env" };
  const rule = RULES[program];
  if (!rule) return { readOnly: false, reason: "program_not_read_only" };
  if (!rule(args)) return { readOnly: false, reason: "arguments_may_change_state" };
  return { readOnly: true };
}

export function classifySshCommand(command: string): SshCommandVerdict {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 2000) return { readOnly: false, reason: "length" };
  if (FORBIDDEN_SHELL.test(trimmed)) return { readOnly: false, reason: "shell_features" };
  if (SECRET_PATH.test(trimmed)) return { readOnly: false, reason: "secret_path" };
  // A plain pipe between read-only programs (e.g. "journalctl -u x | tail -50") is allowed.
  for (const segment of trimmed.split("|")) {
    const verdict = checkSegment(segment);
    if (!verdict.readOnly) return verdict;
  }
  return { readOnly: true };
}
