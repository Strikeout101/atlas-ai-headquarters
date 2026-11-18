import { describe, expect, it, vi } from "vitest";
import {
  extractWebPage,
  fetchPublicWeb,
  isPublicWebAddress,
  parseSearchResults,
  publicWebUrl,
  runAgentWebOperation,
  type AgentWebTransport,
} from "./agent-web.ts";

function ioFor(body = "<title>Research</title><p>Public facts.</p>", contentType = "text/html") {
  const io: AgentWebTransport = {
    resolve: vi.fn(async () => [{ address: "93.184.215.14", family: 4 }]),
    get: vi.fn(async () => ({ status: 200, headers: { "content-type": contentType }, body })),
  };
  return io;
}

describe("agent public web access", () => {
  it.each([
    "127.0.0.1",
    "10.0.69.5",
    "100.100.100.100",
    "169.254.169.254",
    "168.63.129.16",
    "172.20.0.1",
    "192.168.1.1",
    "0.0.0.0",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "2002:7f00:1::",
    "2001:db8::1",
  ])("blocks non-public IP %s", (address) => {
    expect(isPublicWebAddress(address)).toBe(false);
  });

  it.each(["8.8.8.8", "93.184.215.14", "2606:4700:4700::1111"])("permits public address %s", (address) => {
    expect(isPublicWebAddress(address)).toBe(true);
  });

  it.each([
    "file:///etc/passwd",
    "http://127.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://[::ffff:7f00:1]/",
    "http://localhost/",
    "http://atlas.local/",
    "https://user:pass@example.com/",
    "http://example.com:8790/",
  ])("rejects URL %s", (url) => {
    expect(() => publicWebUrl(url)).toThrow();
  });

  it("rejects private DNS results before opening a connection", async () => {
    const io = ioFor();
    io.resolve = vi.fn(async () => [{ address: "10.0.69.5", family: 4 }]);
    await expect(fetchPublicWeb("https://example.com", io)).rejects.toThrow("web_address_forbidden");
    expect(io.get).not.toHaveBeenCalled();
  });

  it("rejects mixed public/private DNS answers", async () => {
    const io = ioFor();
    io.resolve = vi.fn(async () => [
      { address: "93.184.215.14", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(fetchPublicWeb("https://example.com", io)).rejects.toThrow("web_address_forbidden");
    expect(io.get).not.toHaveBeenCalled();
  });

  it("passes the vetted address to the transport and rechecks redirect DNS", async () => {
    const io = ioFor();
    io.resolve = vi.fn(async (host) => [
      { address: host === "example.com" ? "93.184.215.14" : "127.0.0.1", family: 4 },
    ]);
    io.get = vi.fn(async () => ({ status: 302, headers: { location: "https://redirect.example/secret" }, body: "" }));
    await expect(fetchPublicWeb("https://example.com", io)).rejects.toThrow("web_address_forbidden");
    expect(io.get).toHaveBeenCalledOnce();
    expect(io.get).toHaveBeenCalledWith(
      expect.any(URL),
      { address: "93.184.215.14", family: 4 },
      expect.any(AbortSignal),
    );
  });

  it("blocks direct private redirect targets", async () => {
    const io = ioFor();
    io.get = vi.fn(async () => ({
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" },
      body: "",
    }));
    await expect(fetchPublicWeb("https://example.com", io)).rejects.toThrow("web_url_forbidden");
    expect(io.get).toHaveBeenCalledOnce();
  });

  it("bounds redirect loops, response sizes and unsupported files", async () => {
    const loop = ioFor();
    loop.get = vi.fn(async () => ({ status: 302, headers: { location: "/again" }, body: "" }));
    await expect(fetchPublicWeb("https://example.com", loop)).rejects.toThrow("web_too_many_redirects");
    expect(loop.get).toHaveBeenCalledTimes(5);
    await expect(fetchPublicWeb("https://example.com", ioFor("x".repeat(1_000_001)))).rejects.toThrow(
      "web_response_too_large",
    );
    await expect(fetchPublicWeb("https://example.com", ioFor("binary", "application/octet-stream"))).rejects.toThrow(
      "web_unsupported_content_type",
    );
  });

  it("extracts readable text and links, drops scripts, and reports truncation", () => {
    const result = extractWebPage(
      "<title>Rental &amp; repair</title><script>secret()</script><style>css</style><p>Facts " +
        "x".repeat(500) +
        '</p><a href="/prices">Prices &amp; hours</a><a href="http://127.0.0.1/">Private</a>',
      "https://example.com",
      100,
    );
    expect(result.title).toBe("Rental & repair");
    expect(result.text).not.toContain("secret()");
    expect(result.text).not.toContain("css");
    expect(result.text).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(result.links).toEqual([{ title: "Prices & hours", url: "https://example.com/prices" }]);
  });

  it("keeps text/plain content intact", async () => {
    const result = await runAgentWebOperation(
      { operation: "web.read", url: "https://example.com" },
      ioFor("Example <literal> &amp; text", "text/plain"),
    );
    expect(result).toMatchObject({
      text: "Example <literal> &amp; text",
      links: [],
      note: expect.stringContaining("untrusted"),
    });
  });

  it("returns real search source URLs and snippets, skipping duplicate/private links", async () => {
    const rss =
      "<rss><channel><item><title>Business &amp; technology</title><link>https://example.com/guide?a=1&amp;b=2</link><description><![CDATA[<b>Useful</b> facts]]></description></item><item><title>Private</title><link>http://127.0.0.1/</link></item></channel></rss>";
    expect(parseSearchResults(rss, 5)).toEqual([
      { title: "Business & technology", url: "https://example.com/guide?a=1&b=2", snippet: "Useful facts" },
    ]);
    const io = ioFor(rss, "application/rss+xml");
    const result = await runAgentWebOperation(
      { operation: "web.search", query: "local business research", limit: 1 },
      io,
    );
    expect(result).toMatchObject({
      source: "Bing RSS",
      query: "local business research",
      results: [{ title: "Business & technology" }],
    });
    expect(io.get).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "www.bing.com", search: "?q=local+business+research&format=rss" }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("reports search provider challenges instead of inventing results", async () => {
    await expect(
      runAgentWebOperation({ operation: "web.search", query: "research" }, ioFor("<html>Challenge</html>")),
    ).rejects.toThrow("web_search_unavailable");
  });

  it.each([
    { operation: "web.search", query: "" },
    { operation: "web.search", query: "research", limit: 11 },
    { operation: "web.read", url: "https://example.com", max_chars: 50000 },
  ])("validates bounded arguments %j", async (input) => {
    const io = ioFor();
    await expect(runAgentWebOperation(input, io)).rejects.toThrow();
    expect(io.get).not.toHaveBeenCalled();
  });
});
