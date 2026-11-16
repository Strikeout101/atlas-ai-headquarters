import { useEffect, useState } from "react";
import {
  mailboxApi,
  type MailboxConfig,
  type MailSecurity,
  type MailboxInput,
  type MailboxTestResult,
} from "../../api/business-mailboxes";
import { BUSINESS_KINDS, BUSINESS_SETTINGS_NAMES, BUSINESS_SHORT_NAMES, type BusinessKind } from "../../api/business";
import SettingsSection from "./SettingsSection";

const inputClass = "w-full rounded-lg border px-3 py-2 text-sm";
const inputStyle = {
  background: "var(--th-input-bg)",
  borderColor: "var(--th-input-border)",
  color: "var(--th-text-primary)",
};
const buttonClass = "rounded-lg border px-3 py-2 text-sm active:scale-[0.98] disabled:opacity-50";

function MailboxEditor({
  business,
  saved,
  template,
  onSaved,
  onCancel,
}: {
  business: BusinessKind;
  saved?: MailboxConfig;
  template?: MailboxConfig;
  onSaved: (item: MailboxConfig) => void;
  onCancel?: () => void;
}) {
  const [config, setConfig] = useState(saved);
  const [form, setForm] = useState<MailboxInput>(() => ({
    email: saved?.email ?? "",
    username: saved?.username ?? "",
    imap_host: saved?.imap_host ?? template?.imap_host ?? "",
    imap_port: saved?.imap_port ?? template?.imap_port ?? 993,
    smtp_host: saved?.smtp_host ?? template?.smtp_host ?? "",
    smtp_port: saved?.smtp_port ?? template?.smtp_port ?? 465,
    imap_security: saved?.imap_security ?? template?.imap_security ?? "tls",
    smtp_security: saved?.smtp_security ?? template?.smtp_security ?? "tls",
  }));
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<MailboxTestResult | null>(null);
  const prefix = `mailbox-${saved?.id ?? `new-${business}`}`;
  return (
    <form
      className="space-y-4 pt-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        setMessage("");
        setResult(null);
        try {
          const input = { ...form, ...(password ? { password } : {}) };
          const item = saved ? await mailboxApi.update(saved.id, input) : await mailboxApi.create(business, input);
          setConfig(item);
          setPassword("");
          setDirty(false);
          setMessage("Mailbox settings saved. Test the saved connection next.");
          onSaved(item);
        } catch (cause) {
          setError(
            cause instanceof Error && cause.message === "mailbox_email_exists"
              ? "This email address is already configured for this business."
              : "Could not save this mailbox. Your edits are still here; check the fields and try again.",
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset
        disabled={busy}
        className="grid grid-cols-1 gap-4 md:grid-cols-2"
        onChange={() => {
          setDirty(true);
          setMessage("");
          setResult(null);
        }}
      >
        {(
          [
            ["email", "Mailbox address", "email"],
            ["username", "Login username (defaults to mailbox address)", "text"],
            ["imap_host", "IMAP hostname", "text"],
            ["imap_port", "IMAP port", "number"],
            ["smtp_host", "SMTP hostname", "text"],
            ["smtp_port", "SMTP port", "number"],
          ] as const
        ).map(([key, label, type]) => (
          <div key={key} className="flex flex-col gap-2">
            <label htmlFor={`${prefix}-${key}`} className="text-xs">
              {label}
            </label>
            <input
              id={`${prefix}-${key}`}
              type={type}
              value={form[key]}
              required={key !== "username"}
              min={type === "number" ? 1 : undefined}
              max={type === "number" ? 65535 : undefined}
              maxLength={type !== "number" ? 320 : undefined}
              className={inputClass}
              style={inputStyle}
              onChange={(event) =>
                setForm({ ...form, [key]: type === "number" ? Number(event.target.value) : event.target.value })
              }
            />
          </div>
        ))}
        {(
          [
            ["imap_security", "IMAP encryption", 993, 143],
            ["smtp_security", "SMTP encryption", 465, 587],
          ] as const
        ).map(([key, label, tlsPort, startTlsPort]) => (
          <div key={key} className="flex flex-col gap-2">
            <label htmlFor={`${prefix}-${key}`} className="text-xs">
              {label}
            </label>
            <select
              id={`${prefix}-${key}`}
              value={form[key]}
              className={inputClass}
              style={inputStyle}
              onChange={(event) => setForm({ ...form, [key]: event.target.value as MailSecurity })}
            >
              <option value="tls">{`TLS from the start (usually port ${tlsPort})`}</option>
              <option value="starttls">{`STARTTLS (usually port ${startTlsPort})`}</option>
            </select>
          </div>
        ))}
        <div className="flex flex-col gap-2 md:col-span-2">
          <label htmlFor={`${prefix}-password`} className="text-xs">
            Mailbox password
          </label>
          <input
            id={`${prefix}-password`}
            type="password"
            autoComplete="new-password"
            value={password}
            maxLength={4096}
            className={inputClass}
            style={inputStyle}
            aria-describedby={`${prefix}-password-help`}
            onChange={(event) => setPassword(event.target.value)}
          />
          <p id={`${prefix}-password-help`} className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
            {config?.has_password
              ? "A password is stored. Leave blank to keep it, or enter a replacement."
              : "Save server settings first if needed. Add this mailbox's password before testing. Passwords are encrypted and never returned to this form."}
          </p>
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {result && (
        <p role="status" className="text-sm">
          IMAP: {result.imap.ok ? "Connected" : `Failed (${result.imap.error ?? "connection_failed"})`}. SMTP:{" "}
          {result.smtp.ok ? "Connected" : `Failed (${result.smtp.error ?? "connection_failed"})`}.
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <button disabled={busy} className={`${buttonClass} ax-btn-primary`}>
          {busy ? "Working…" : saved ? "Save mailbox" : "Add mailbox"}
        </button>
        {saved && (
          <button
            type="button"
            disabled={busy || !config?.has_password || dirty}
            className={buttonClass}
            style={{ borderColor: "var(--th-input-border)" }}
            onClick={async () => {
              setBusy(true);
              setError("");
              setMessage("");
              setResult(null);
              try {
                const next = await mailboxApi.test(saved.id);
                setResult(next);
                const item = { ...saved, last_test_at: next.tested_at, last_test_ok: next.imap.ok && next.smtp.ok };
                setConfig(item);
                onSaved(item);
              } catch {
                setError("Could not test this mailbox. Check the saved settings and try again.");
              } finally {
                setBusy(false);
              }
            }}
          >
            Test saved connection
          </button>
        )}
        {onCancel && (
          <button type="button" disabled={busy} className={buttonClass} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {dirty && config && <p className="text-xs">Save your changes before testing.</p>}
    </form>
  );
}

export default function BusinessMailboxes() {
  const [items, setItems] = useState<MailboxConfig[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [adding, setAdding] = useState<BusinessKind | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setError("");
    mailboxApi.list().then(
      (next) => {
        if (active) setItems(next);
      },
      () => {
        if (active) setError("Could not load mailboxes.");
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);
  const updateItem = (item: MailboxConfig) =>
    setItems((current) => [...(current ?? []).filter((entry) => entry.id !== item.id), item]);
  return (
    <SettingsSection
      title="Mailcow connections"
      description={`${items?.length ?? 0} mailboxes · multiple addresses per business`}
    >
      <p className="mb-4 max-w-prose text-sm" style={{ color: "var(--th-text-secondary)" }}>
        Each mailbox has its own login. Agents can choose a sender; the default is used when none is selected. Every
        outgoing message still needs your approval. Connection tests sign in without sending mail. Connections are
        always encrypted: TLS from the start (IMAP 993, SMTP 465) or STARTTLS (IMAP 143, SMTP 587).
      </p>
      {error && (
        <p role="alert" className="mb-3 text-sm">
          {error}{" "}
          <button type="button" className="underline" onClick={() => setAttempt(attempt + 1)}>
            Try again
          </button>
        </p>
      )}
      {items === null && !error ? (
        <div
          aria-label="Loading mailboxes"
          className="h-24 animate-pulse rounded-lg"
          style={{ background: "var(--th-input-bg)" }}
        />
      ) : (
        items && (
          <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-2">
            {BUSINESS_KINDS.map((business) => {
              const accounts = items
                .filter((item) => item.business === business)
                .sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.email.localeCompare(b.email));
              return (
                <section
                  key={business}
                  className="min-w-0 space-y-3"
                  aria-label={`${BUSINESS_SHORT_NAMES[business]} mailboxes`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">
                      {BUSINESS_SETTINGS_NAMES[business]}{" "}
                      <span className="font-normal text-[var(--th-text-secondary)]">({accounts.length})</span>
                    </h3>
                    <button type="button" className={buttonClass} onClick={() => setAdding(business)}>
                      Add mailbox
                    </button>
                  </div>
                  {accounts.length === 0 && adding !== business && (
                    <p className="text-sm text-[var(--th-text-secondary)]">No mailboxes configured.</p>
                  )}
                  {accounts.map((item) => (
                    <details
                      key={item.id}
                      className="min-w-0 rounded-lg border p-3"
                      style={{ borderColor: "var(--th-border)" }}
                    >
                      <summary className="cursor-pointer break-all text-sm font-medium">
                        {item.email}{" "}
                        {item.is_default && (
                          <span className="ml-1 text-xs font-normal text-[var(--th-text-secondary)]">Default</span>
                        )}
                        <span className="mt-1 block text-xs font-normal text-[var(--th-text-secondary)]">
                          {item.last_test_ok
                            ? "Connection verified"
                            : item.has_password
                              ? "Password saved · test connection"
                              : "Password needed"}
                        </span>
                      </summary>
                      <MailboxEditor business={business} saved={item} onSaved={updateItem} />
                      {!item.is_default && (
                        <button
                          type="button"
                          disabled={switching !== null}
                          className={`${buttonClass} mt-3`}
                          onClick={async () => {
                            setSwitching(item.id);
                            setError("");
                            try {
                              await mailboxApi.update(item.id, { is_default: true });
                              setItems(await mailboxApi.list());
                            } catch {
                              setError("Could not change the default mailbox.");
                            } finally {
                              setSwitching(null);
                            }
                          }}
                        >
                          {switching === item.id ? "Updating…" : "Use as default sender"}
                        </button>
                      )}
                    </details>
                  ))}
                  {adding === business && (
                    <div className="rounded-lg border p-4" style={{ borderColor: "var(--th-input-border)" }}>
                      <h4 className="text-sm font-semibold">New mailbox</h4>
                      <MailboxEditor
                        business={business}
                        template={accounts.find((item) => item.is_default)}
                        onSaved={(item) => {
                          updateItem(item);
                          setAdding(null);
                        }}
                        onCancel={() => setAdding(null)}
                      />
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )
      )}
    </SettingsSection>
  );
}
