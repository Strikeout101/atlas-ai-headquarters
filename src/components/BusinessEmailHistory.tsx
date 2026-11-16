import { useEffect, useState } from "react";
import { businessEmailApi, type EmailApproval } from "../api/business-email";
import type { BusinessKind } from "../api/business";

export default function BusinessEmailHistory({ business }: { business: BusinessKind }) {
  const [items, setItems] = useState<EmailApproval[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const next = await businessEmailApi.list();
        if (active) {
          setItems(next.filter((item) => item.business === business));
          setLoaded(true);
          setError(false);
        }
      } catch {
        if (active) setError(true);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [business, attempt]);
  return (
    <section className="mt-6 border-t pt-5" style={{ borderColor: "var(--th-border)" }}>
      <h2 className="text-lg font-semibold">Email delivery history</h2>
      <p className="mt-2 text-sm" style={{ color: "var(--th-text-secondary)" }}>
        Review pending messages in Today or the task drawer. Sending means delivery is in progress; sent means the SMTP
        server accepted the message, not that it reached the inbox.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm">
          Could not refresh email history.{" "}
          <button type="button" className="underline" onClick={() => setAttempt(attempt + 1)}>
            Try again
          </button>
        </p>
      )}
      {!loaded && !error ? (
        <div
          aria-label="Loading email history"
          className="mt-3 h-20 animate-pulse"
          style={{ background: "var(--th-bg-surface)" }}
        />
      ) : items.length === 0 ? (
        <p className="mt-3 text-sm">No email approvals or deliveries for this business yet.</p>
      ) : (
        <ul className="mt-3 divide-y" style={{ borderColor: "var(--th-border)" }}>
          {items.map((item) => (
            <li key={item.id} className="py-3 text-sm">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="font-medium break-words">{item.subject || "(no subject)"}</span>
                <span>{item.status}</span>
              </div>
              <p className="mt-1 break-all" style={{ color: "var(--th-text-secondary)" }}>
                {item.sender} → {item.recipient}
              </p>
              <p className="mt-1 text-xs">
                {new Date(item.created_at).toLocaleString()}
                {item.error_code ? ` · ${item.error_code}` : ""}
              </p>
              {(item.status === "unknown" || item.status === "sending") && (
                <p className="mt-1 text-xs">
                  Delivery may already have occurred. Check the mail server before creating another request; this
                  message will not be retried automatically.
                </p>
              )}
              <details className="mt-2">
                <summary className="cursor-pointer text-xs">View exact message</summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans">{item.body}</pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
