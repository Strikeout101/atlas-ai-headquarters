import { useEffect, useState } from "react";
import { studioApi, type MediaAsset } from "../../api/studio";

/** The media library: images the studio made (and their source, license and cost), newest first. */
export default function MediaPanel() {
  const [items, setItems] = useState<MediaAsset[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => {
      studioApi
        .media({ q: query.trim() || undefined })
        .then((list) => {
          setItems(list);
          setError("");
        })
        .catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load media."));
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  return (
    <div>
      <p className="max-w-[70ch] text-sm" style={{ color: "var(--th-text-secondary)" }}>
        Images the studio made for products and listings: free mockups and, when you turn it on, AI-generated images
        with their cost. Each shows where it came from and its license note.
      </p>
      <input
        type="search"
        aria-label="Search media"
        placeholder="Search tags, prompts or files"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="mt-3 w-full max-w-md rounded-lg border px-3 py-2 text-sm"
        style={{
          background: "var(--th-input-bg)",
          borderColor: "var(--th-input-border)",
          color: "var(--th-text-primary)",
        }}
      />
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-500">
          {error}
        </p>
      )}
      {items && !items.length && (
        <p className="mt-4 text-sm" style={{ color: "var(--th-text-muted)" }}>
          No images yet. Agents add them with studio.mockup during the Etsy playbook.
        </p>
      )}
      {items && items.length > 0 && (
        <ul aria-label="Media" className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((item) => (
            <li key={item.id} className="overflow-hidden rounded-xl border" style={{ borderColor: "var(--th-border)" }}>
              <img
                src={studioApi.fileUrl(item.id)}
                alt={item.prompt || item.path}
                loading="lazy"
                className="aspect-[5/4] w-full bg-white object-contain"
              />
              <div className="space-y-1 p-2 text-xs">
                <p className="break-words font-medium">{item.prompt || item.path}</p>
                <p style={{ color: "var(--th-text-muted)" }}>
                  {item.kind} · {item.source}
                  {item.cost_minor > 0 ? ` · $${(item.cost_minor / 100).toFixed(2)}` : " · free"}
                </p>
                {item.tags.length > 0 && <p style={{ color: "var(--th-text-muted)" }}>{item.tags.join(", ")}</p>}
                <p className="break-words" style={{ color: "var(--th-text-muted)" }}>
                  {item.license}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
