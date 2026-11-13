import { BlockList, isIP } from "node:net";

import { ALLOWED_HOSTS, ALLOWED_ORIGINS, ALLOWED_ORIGIN_SUFFIXES, TRUSTED_NETWORKS } from "../config/runtime.ts";

/** The parts of an HTTP request this module reads; satisfied by Express requests and wrapped IncomingMessages. */
export type HeaderReadableRequest = {
  socket?: { remoteAddress?: string };
  header(name: string): string | undefined;
};

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
}

export function isLoopbackRequest(req: { socket?: { remoteAddress?: string } }): boolean {
  return isLoopbackAddress(req.socket?.remoteAddress);
}

function unmapIpv4(address: string): string {
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:") && isIP(lower.slice(7)) === 4) return lower.slice(7);
  return lower;
}

/** Normalizes an address taken from a socket or a forwarding header: quotes, brackets, ports, IPv4-mapped IPv6. */
export function normalizeClientAddress(raw: string): string {
  let value = raw.trim().replace(/^"|"$/g, "");
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    value = end > 0 ? value.slice(1, end) : value;
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(value)) {
    // IPv4 with port ("127.0.0.1:1234"); bare IPv6 contains several colons and is left as-is.
    value = value.slice(0, value.lastIndexOf(":"));
  }
  return unmapIpv4(value);
}

function isLoopbackClientAddress(raw: string): boolean {
  const value = normalizeClientAddress(raw);
  return isLoopbackAddress(value) || value === "localhost";
}

function hostnameFromHostHeader(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader.trim()}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostHeaderIsLoopback(hostHeader: string | undefined): boolean {
  const hostname = hostnameFromHostHeader(hostHeader);
  return hostname !== null && isLoopbackHostname(hostname);
}

const CLIENT_ADDRESS_HEADERS = ["x-forwarded-for", "x-real-ip", "cf-connecting-ip", "true-client-ip", "x-client-ip"];

function forwardedForValues(header: string): string[] {
  return [...header.matchAll(/for=("[^"]*"|[^;,\s]+)/gi)].map((m) => m[1]);
}

/**
 * True only for requests made directly on this machine (not relayed by a reverse proxy, tunnel, or dev proxy
 * for a remote browser). A same-host proxy such as nginx, Tailscale Serve, or cloudflared connects from
 * 127.0.0.1, so the socket address alone cannot grant trust: the Host header must also be a loopback name and
 * every client address a proxy reports must be loopback. Proxies append the real client address, so a remote
 * client cannot hide it by sending its own loopback-valued headers.
 */
export function isDirectLocalRequest(req: HeaderReadableRequest): boolean {
  if (!isLoopbackRequest(req)) return false;
  if (!hostHeaderIsLoopback(req.header("host"))) return false;
  const forwardedHost = req.header("x-forwarded-host");
  if (forwardedHost && !forwardedHost.split(",").every((h) => hostHeaderIsLoopback(h))) return false;
  for (const name of CLIENT_ADDRESS_HEADERS) {
    const value = req.header(name);
    if (value === undefined) continue;
    const entries = value.split(",").filter((entry) => entry.trim());
    if (!entries.every(isLoopbackClientAddress)) return false;
  }
  const forwarded = req.header("forwarded");
  if (forwarded !== undefined) {
    if (/\bhost=/i.test(forwarded) || !forwardedForValues(forwarded).every(isLoopbackClientAddress)) return false;
  }
  return true;
}

/**
 * The browser's address. A direct connection is taken from the socket. When the socket is loopback, a proxy on
 * this machine may be relaying, so the address that proxy appended (the last X-Forwarded-For entry, X-Real-IP,
 * or the last Forwarded for=) is used instead. Headers from non-loopback peers are ignored because anyone can
 * send them.
 */
export function resolveClientAddress(req: HeaderReadableRequest): string | null {
  const peer = req.socket?.remoteAddress;
  if (!peer) return null;
  const peerAddress = normalizeClientAddress(peer);
  if (!isLoopbackAddress(peerAddress)) return peerAddress;
  const xff = req.header("x-forwarded-for");
  const xffEntries = xff
    ? xff
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
  if (xffEntries.length > 0) return normalizeClientAddress(xffEntries[xffEntries.length - 1]);
  const realIp = req.header("x-real-ip");
  if (realIp?.trim()) return normalizeClientAddress(realIp);
  const forwarded = req.header("forwarded");
  const forwardedFor = forwarded ? forwardedForValues(forwarded) : [];
  if (forwardedFor.length > 0) return normalizeClientAddress(forwardedFor[forwardedFor.length - 1]);
  return peerAddress;
}

export type TrustedNetworkConfig = { blockList: BlockList; accepted: string[]; rejected: string[] };

export function parseTrustedNetworks(entries: readonly string[]): TrustedNetworkConfig {
  const blockList = new BlockList();
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    const [addressPart, prefixPart, extra] = entry.split("/");
    const address = normalizeClientAddress(addressPart ?? "");
    const family = isIP(address);
    const maxPrefix = family === 4 ? 32 : 128;
    const prefix = prefixPart === undefined ? maxPrefix : Number(prefixPart);
    if (!family || extra !== undefined || !/^\d+$/.test(String(prefix)) || prefix < 0 || prefix > maxPrefix) {
      rejected.push(entry);
      continue;
    }
    blockList.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
    accepted.push(`${address}/${prefix}`);
  }
  return { blockList, accepted, rejected };
}

const configuredTrustedNetworks = parseTrustedNetworks(TRUSTED_NETWORKS);
if (configuredTrustedNetworks.rejected.length > 0) {
  console.warn(
    `[Claw-Empire] Ignoring invalid TRUSTED_NETWORKS entries: ${configuredTrustedNetworks.rejected.join(", ")}`,
  );
}

export function getTrustedNetworkSummary(): { networks: string[]; allowedHosts: string[] } {
  return { networks: [...configuredTrustedNetworks.accepted], allowedHosts: [...ALLOWED_HOSTS] };
}

export function isAddressInTrustedNetworks(
  address: string,
  config: TrustedNetworkConfig = configuredTrustedNetworks,
): boolean {
  const normalized = normalizeClientAddress(address);
  const family = isIP(normalized);
  if (!family) return false;
  return config.blockList.check(normalized, family === 4 ? "ipv4" : "ipv6");
}

/**
 * Host names a browser may use for automatic sign-in and same-origin requests. Domain names must be listed
 * explicitly (ALLOWED_HOSTS or ALLOWED_ORIGINS) so a DNS-rebinding page on an attacker's domain cannot ride a
 * trusted network's automatic sign-in. IP-address hosts are safe because rebinding needs a domain name.
 */
export function isKnownHostHeader(hostHeader: string | undefined): boolean {
  const hostname = hostnameFromHostHeader(hostHeader);
  if (!hostname) return false;
  if (isLoopbackHostname(hostname)) return true;
  if (isIP(hostname.replace(/^\[|\]$/g, ""))) return true;
  if (ALLOWED_HOSTS.includes(hostname)) return true;
  return ALLOWED_ORIGINS.some((origin) => {
    try {
      return new URL(origin).hostname.toLowerCase() === hostname;
    } catch {
      return false;
    }
  });
}

/** True when the browser is on a configured trusted network (e.g. one of the owner's VLANs). */
export function isTrustedNetworkRequest(
  req: HeaderReadableRequest,
  config: TrustedNetworkConfig = configuredTrustedNetworks,
): boolean {
  if (config.accepted.length === 0) return false;
  if (!isKnownHostHeader(req.header("host"))) return false;
  const address = resolveClientAddress(req);
  return address !== null && isAddressInTrustedNetworks(address, config);
}

export function isTrustedOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (isLoopbackHostname(u.hostname)) return true;
    if (ALLOWED_ORIGINS.includes(origin)) return true;
    return ALLOWED_ORIGIN_SUFFIXES.some((suffix) => u.hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

/** Configured origins, plus the page's own origin when it is served under a known host (e.g. http://192.168.10.5:8790). */
export function isTrustedOriginForRequest(origin: string, req: HeaderReadableRequest): boolean {
  if (isTrustedOrigin(origin)) return true;
  const host = req.header("host");
  if (!host || !isKnownHostHeader(host)) return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return u.host.toLowerCase() === host.trim().toLowerCase();
  } catch {
    return false;
  }
}
