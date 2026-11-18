import type { ReactNode } from "react";

/**
 * A small, safe renderer for the owner's own markdown files (systems registry, checklist). It builds React elements
 * from headings, lists, checkboxes, tables, code blocks and paragraphs; it never injects HTML.
 */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const token = match[0];
    const id = `${key}-${index++}`;
    if (token.startsWith("**")) out.push(<strong key={id}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("`"))
      out.push(
        <code key={id} className="rounded px-1 text-[0.92em]" style={{ background: "var(--th-bg-surface)" }}>
          {token.slice(1, -1)}
        </code>,
      );
    else {
      const label = token.slice(1, token.indexOf("]"));
      out.push(
        <a key={id} href={match[2]} target="_blank" rel="noreferrer" className="text-sky-500 hover:underline">
          {label}
        </a>,
      );
    }
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export default function MarkdownView({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    const id = `b${key++}`;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      blocks.push(
        <pre
          key={id}
          className="my-2 overflow-x-auto rounded-lg p-3 text-xs"
          style={{ background: "var(--th-bg-surface)" }}
        >
          {code.join("\n")}
        </pre>,
      );
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const className =
        level === 1
          ? "mt-2 text-lg font-semibold"
          : level === 2
            ? "mt-6 border-b pb-1 text-base font-semibold"
            : "mt-4 text-sm font-semibold";
      blocks.push(
        <div
          key={id}
          role="heading"
          aria-level={level}
          className={className}
          style={{ borderColor: "var(--th-border)", color: "var(--th-text-heading)" }}
        >
          {inline(heading[2], id)}
        </div>,
      );
      i++;
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={id} className="my-2 overflow-x-auto">
          <table className="w-full min-w-[480px] border-collapse text-left text-xs">
            <thead>
              <tr>
                {head.map((cell, c) => (
                  <th
                    key={c}
                    className="border-b px-2 py-1.5 font-semibold"
                    style={{ borderColor: "var(--th-border)" }}
                  >
                    {inline(cell, `${id}h${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className="border-b px-2 py-1.5 align-top" style={{ borderColor: "var(--th-border)" }}>
                      {inline(cell, `${id}r${r}c${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: Array<{ text: string; checked: boolean | null; depth: number }> = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const raw = lines[i++];
        const depth = Math.min(3, Math.floor((raw.match(/^\s*/)?.[0].length ?? 0) / 2));
        let body = raw.replace(/^\s*[-*]\s+/, "");
        let checked: boolean | null = null;
        const box = body.match(/^\[( |x|X)\]\s+/);
        if (box) {
          checked = box[1].toLowerCase() === "x";
          body = body.slice(box[0].length);
        }
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]))
          body += ` ${lines[i++].trim()}`;
        items.push({ text: body, checked, depth });
      }
      blocks.push(
        <ul key={id} className="my-2 space-y-1 text-sm">
          {items.map((item, n) => (
            <li key={n} className="flex gap-2" style={{ paddingLeft: `${item.depth * 1.25}rem` }}>
              <span aria-hidden className="shrink-0" style={{ color: "var(--th-text-muted)" }}>
                {item.checked === null ? "•" : item.checked ? "☑" : "☐"}
              </span>
              <span className={item.checked ? "line-through opacity-70" : ""}>
                {item.checked !== null && <span className="sr-only">{item.checked ? "Done: " : "Open: "}</span>}
                {inline(item.text, `${id}i${n}`)}
              </span>
            </li>
          ))}
        </ul>,
      );
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*[-*]\s+|\s*\|)/.test(lines[i]))
      paragraph.push(lines[i++].trim());
    if (!paragraph.length) {
      i++;
      continue;
    }
    blocks.push(
      <p key={id} className="my-2 text-sm leading-relaxed" style={{ color: "var(--th-text-primary)" }}>
        {inline(paragraph.join(" "), id)}
      </p>,
    );
  }
  return <div className="min-w-0 break-words">{blocks}</div>;
}
