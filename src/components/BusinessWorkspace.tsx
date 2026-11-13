import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  businessApi,
  type BusinessContact,
  type BusinessKind,
  type CommunicationDraft,
  type DraftChannel,
  type DraftPurpose,
  type RentalQuote,
  type TechTicket,
} from "../api/business";

type Section = "contacts" | "work" | "drafts";

const inputClass =
  "w-full rounded-lg border border-slate-500/40 bg-[var(--th-bg-surface)] px-3 py-2 text-sm text-[var(--th-text-primary)] outline-none focus:border-sky-500";
const labelClass = "grid gap-1.5 text-xs font-medium text-[var(--th-text-secondary)]";
const buttonClass =
  "rounded-lg border border-slate-500/40 px-3 py-2 text-sm font-medium text-[var(--th-text-primary)] transition hover:bg-slate-500/10 active:scale-[0.98]";
const primaryClass =
  "rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-500 active:scale-[0.98]";

const ticketStatuses: TechTicket["status"][] = ["new", "scheduled", "active", "waiting", "done"];
const quoteStatuses: RentalQuote["status"][] = ["draft", "shared", "accepted", "declined", "archived"];
const draftStatuses: CommunicationDraft["status"][] = ["draft", "ready", "archived"];
const channels: DraftChannel[] = ["email", "social", "sms"];
const purposes: DraftPurpose[] = ["outreach", "promotion", "follow_up", "checkin", "checkout", "general"];

function displayStatus(value: string): string {
  return value.replace(/_/g, " ");
}

function contactName(contacts: BusinessContact[], id: string | null): string {
  return contacts.find((contact) => contact.id === id)?.name ?? "No linked contact";
}

function StatusSelect<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: T[];
  onChange: (next: T) => void;
}) {
  return (
    <select
      aria-label="Status"
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
      className="rounded-md border border-slate-500/30 bg-[var(--th-bg-surface)] px-2 py-1 text-xs text-[var(--th-text-primary)]"
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {displayStatus(option)}
        </option>
      ))}
    </select>
  );
}

export default function BusinessWorkspace() {
  const [business, setBusiness] = useState<BusinessKind>("tech");
  const [section, setSection] = useState<Section>("work");
  const [contacts, setContacts] = useState<BusinessContact[]>([]);
  const [tickets, setTickets] = useState<TechTicket[]>([]);
  const [quotes, setQuotes] = useState<RentalQuote[]>([]);
  const [drafts, setDrafts] = useState<CommunicationDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [contactId, setContactId] = useState<string | null>(null);
  const [contactForm, setContactForm] = useState({ name: "", email: "", phone: "", notes: "" });
  const [workId, setWorkId] = useState<string | null>(null);
  const [workForm, setWorkForm] = useState({
    contact_id: "",
    title: "",
    device: "",
    event_date: "",
    details: "",
    extra: "",
  });
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftForm, setDraftForm] = useState<{
    contact_id: string;
    channel: DraftChannel;
    purpose: DraftPurpose;
    subject: string;
    body: string;
  }>({ contact_id: "", channel: "email", purpose: "outreach", subject: "", body: "" });

  const reload = useCallback(async (kind: BusinessKind) => {
    setLoading(true);
    setError(null);
    try {
      const [nextContacts, nextDrafts, nextWork] = await Promise.all([
        businessApi.contacts.list(kind),
        businessApi.drafts.list(kind),
        kind === "tech" ? businessApi.tickets.list() : businessApi.quotes.list(),
      ]);
      setContacts(nextContacts);
      setDrafts(nextDrafts);
      if (kind === "tech") setTickets(nextWork as TechTicket[]);
      else setQuotes(nextWork as RentalQuote[]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load business records.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload(business);
  }, [business, reload]);

  const selectBusiness = (kind: BusinessKind) => {
    setBusiness(kind);
    setSection("work");
    setContactId(null);
    setWorkId(null);
    setDraftId(null);
    setContactForm({ name: "", email: "", phone: "", notes: "" });
    setWorkForm({ contact_id: "", title: "", device: "", event_date: "", details: "", extra: "" });
    setDraftForm({ contact_id: "", channel: "email", purpose: "outreach", subject: "", body: "" });
    setNotice(null);
  };

  const run = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await operation();
      await reload(business);
      setNotice(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the record.");
    } finally {
      setBusy(false);
    }
  };

  const saveContact = async (event: FormEvent) => {
    event.preventDefault();
    if (!contactForm.name.trim()) return setError("Contact name is required.");
    await run(
      async () => {
        if (contactId) await businessApi.contacts.update(contactId, contactForm);
        else await businessApi.contacts.create({ business, ...contactForm });
        setContactId(null);
        setContactForm({ name: "", email: "", phone: "", notes: "" });
      },
      contactId ? "Contact updated." : "Contact added.",
    );
  };

  const saveWork = async (event: FormEvent) => {
    event.preventDefault();
    if (!workForm.title.trim() || !workForm.details.trim()) return setError("Title and details are required.");
    await run(
      async () => {
        const linkedContact = workForm.contact_id || null;
        if (business === "tech") {
          const input = {
            contact_id: linkedContact,
            title: workForm.title,
            device: workForm.device,
            description: workForm.details,
          };
          if (workId) await businessApi.tickets.update(workId, input);
          else await businessApi.tickets.create({ ...input, status: "new" });
        } else {
          const input = {
            contact_id: linkedContact,
            event_name: workForm.title,
            event_date: workForm.event_date,
            items: workForm.details,
            quote_text: workForm.extra,
          };
          if (workId) await businessApi.quotes.update(workId, input);
          else await businessApi.quotes.create({ ...input, status: "draft" });
        }
        setWorkId(null);
        setWorkForm({ contact_id: "", title: "", device: "", event_date: "", details: "", extra: "" });
      },
      workId ? "Record updated." : business === "tech" ? "Ticket added." : "Quote drafted.",
    );
  };

  const saveDraft = async (event: FormEvent) => {
    event.preventDefault();
    if (!draftForm.body.trim()) return setError("Draft body is required.");
    await run(
      async () => {
        const input = { ...draftForm, contact_id: draftForm.contact_id || null };
        if (draftId) await businessApi.drafts.update(draftId, input);
        else await businessApi.drafts.create({ business, ...input, status: "draft" });
        setDraftId(null);
        setDraftForm({ contact_id: "", channel: "email", purpose: "outreach", subject: "", body: "" });
      },
      draftId ? "Draft updated." : "Draft saved.",
    );
  };

  const remove = async (kind: "contact" | "ticket" | "quote" | "draft", id: string) => {
    if (!window.confirm("Delete this record?")) return;
    await run(() => {
      if (kind === "contact") return businessApi.contacts.remove(id);
      if (kind === "ticket") return businessApi.tickets.remove(id);
      if (kind === "quote") return businessApi.quotes.remove(id);
      return businessApi.drafts.remove(id);
    }, "Record deleted.");
  };

  const count =
    section === "contacts"
      ? contacts.length
      : section === "drafts"
        ? drafts.length
        : business === "tech"
          ? tickets.length
          : quotes.length;

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 text-[var(--th-text-primary)] md:px-6">
      <div className="grid gap-4 border-b border-slate-500/20 pb-5 md:grid-cols-[1fr_auto] md:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-500">Operations</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">Business workspace</h1>
          <p className="mt-2 max-w-[65ch] text-sm text-[var(--th-text-secondary)]">
            Keep customer work and outreach drafts together. Drafts stay here until you choose how to send or publish
            them.
          </p>
        </div>
        <div className="flex rounded-xl border border-slate-500/30 p-1" role="group" aria-label="Business">
          {(["tech", "rental"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              aria-pressed={business === kind}
              onClick={() => selectBusiness(kind)}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition active:scale-[0.98] ${business === kind ? "bg-sky-600 text-white" : "text-[var(--th-text-secondary)] hover:bg-slate-500/10"}`}
            >
              {kind === "tech" ? "Tech services" : "Party rentals"}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Business records">
        {(
          [
            ["work", business === "tech" ? "Service tickets" : "Rental quotes"],
            ["contacts", "Contacts"],
            ["drafts", "Communications"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={section === key}
            onClick={() => setSection(key)}
            className={`rounded-full border px-4 py-2 text-sm transition active:scale-[0.98] ${section === key ? "border-sky-500 bg-sky-500/10 text-sky-500" : "border-slate-500/30 hover:bg-slate-500/10"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-500"
        >
          {notice}
        </div>
      )}
      {loading ? (
        <div className="grid gap-3 md:grid-cols-2" aria-label="Loading business records">
          <div className="h-56 animate-pulse rounded-xl bg-slate-500/10" />
          <div className="h-56 animate-pulse rounded-xl bg-slate-500/10" />
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]">
          <div className="min-w-0 space-y-3">
            <div className="flex items-baseline justify-between border-b border-slate-500/20 pb-3">
              <h2 className="text-lg font-semibold">
                {section === "contacts"
                  ? "Contacts"
                  : section === "drafts"
                    ? "Communication drafts"
                    : business === "tech"
                      ? "Service tickets"
                      : "Rental quotes"}
              </h2>
              <span className="text-xs text-[var(--th-text-secondary)]">{count} records</span>
            </div>
            {count === 0 && (
              <div className="rounded-xl border border-dashed border-slate-500/30 px-5 py-12 text-center text-sm text-[var(--th-text-secondary)]">
                No records yet. Use the form to add the first one.
              </div>
            )}

            {section === "contacts" &&
              contacts.map((contact) => (
                <article key={contact.id} className="rounded-xl border border-slate-500/20 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="font-semibold">{contact.name}</h3>
                      <p className="mt-1 text-xs text-[var(--th-text-secondary)]">
                        {[contact.email, contact.phone].filter(Boolean).join(" · ") || "No contact details"}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className={buttonClass}
                        onClick={() => {
                          setContactId(contact.id);
                          setContactForm({
                            name: contact.name,
                            email: contact.email ?? "",
                            phone: contact.phone ?? "",
                            notes: contact.notes ?? "",
                          });
                        }}
                      >
                        Edit
                      </button>
                      <button type="button" className={buttonClass} onClick={() => void remove("contact", contact.id)}>
                        Delete
                      </button>
                    </div>
                  </div>
                  {contact.notes && (
                    <p className="mt-3 whitespace-pre-wrap text-sm text-[var(--th-text-secondary)]">{contact.notes}</p>
                  )}
                </article>
              ))}

            {section === "work" &&
              business === "tech" &&
              tickets.map((ticket) => (
                <article key={ticket.id} className="rounded-xl border border-slate-500/20 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="font-semibold">{ticket.title}</h3>
                      <p className="mt-1 text-xs text-[var(--th-text-secondary)]">
                        {contactName(contacts, ticket.contact_id)}
                        {ticket.device ? ` · ${ticket.device}` : ""}
                      </p>
                    </div>
                    <StatusSelect
                      value={ticket.status}
                      options={ticketStatuses}
                      onChange={(status) =>
                        void run(() => businessApi.tickets.update(ticket.id, { status }), "Ticket status updated.")
                      }
                    />
                  </div>
                  {ticket.description && (
                    <p className="mt-3 whitespace-pre-wrap text-sm text-[var(--th-text-secondary)]">
                      {ticket.description}
                    </p>
                  )}
                  <div className="mt-4 flex gap-2">
                    <button
                      type="button"
                      className={buttonClass}
                      onClick={() => {
                        setWorkId(ticket.id);
                        setWorkForm({
                          contact_id: ticket.contact_id ?? "",
                          title: ticket.title,
                          device: ticket.device ?? "",
                          event_date: "",
                          details: ticket.description ?? "",
                          extra: "",
                        });
                      }}
                    >
                      Edit
                    </button>
                    <button type="button" className={buttonClass} onClick={() => void remove("ticket", ticket.id)}>
                      Delete
                    </button>
                  </div>
                </article>
              ))}

            {section === "work" &&
              business === "rental" &&
              quotes.map((quote) => (
                <article key={quote.id} className="rounded-xl border border-slate-500/20 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="font-semibold">{quote.event_name}</h3>
                      <p className="mt-1 text-xs text-[var(--th-text-secondary)]">
                        {contactName(contacts, quote.contact_id)}
                        {quote.event_date ? ` · ${quote.event_date}` : ""}
                      </p>
                    </div>
                    <StatusSelect
                      value={quote.status}
                      options={quoteStatuses}
                      onChange={(status) =>
                        void run(() => businessApi.quotes.update(quote.id, { status }), "Quote status updated.")
                      }
                    />
                  </div>
                  <p className="mt-3 whitespace-pre-wrap text-sm">{quote.items}</p>
                  {quote.quote_text && (
                    <p className="mt-3 whitespace-pre-wrap border-t border-slate-500/20 pt-3 text-sm text-[var(--th-text-secondary)]">
                      {quote.quote_text}
                    </p>
                  )}
                  <div className="mt-4 flex gap-2">
                    <button
                      type="button"
                      className={buttonClass}
                      onClick={() => {
                        setWorkId(quote.id);
                        setWorkForm({
                          contact_id: quote.contact_id ?? "",
                          title: quote.event_name,
                          device: "",
                          event_date: quote.event_date ?? "",
                          details: quote.items,
                          extra: quote.quote_text ?? "",
                        });
                      }}
                    >
                      Edit
                    </button>
                    <button type="button" className={buttonClass} onClick={() => void remove("quote", quote.id)}>
                      Delete
                    </button>
                  </div>
                </article>
              ))}

            {section === "drafts" &&
              drafts.map((draft) => (
                <article key={draft.id} className="rounded-xl border border-slate-500/20 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-sky-500">
                        {draft.channel} · {displayStatus(draft.purpose)}
                      </p>
                      <h3 className="mt-1 font-semibold">{draft.subject || "Untitled draft"}</h3>
                      <p className="mt-1 text-xs text-[var(--th-text-secondary)]">
                        {contactName(contacts, draft.contact_id)}
                      </p>
                    </div>
                    <StatusSelect
                      value={draft.status}
                      options={draftStatuses}
                      onChange={(status) =>
                        void run(() => businessApi.drafts.update(draft.id, { status }), "Draft status updated.")
                      }
                    />
                  </div>
                  <p className="mt-3 whitespace-pre-wrap text-sm text-[var(--th-text-secondary)]">{draft.body}</p>
                  <div className="mt-4 flex gap-2">
                    <button
                      type="button"
                      className={buttonClass}
                      onClick={() => {
                        setDraftId(draft.id);
                        setDraftForm({
                          contact_id: draft.contact_id ?? "",
                          channel: draft.channel,
                          purpose: draft.purpose,
                          subject: draft.subject ?? "",
                          body: draft.body,
                        });
                      }}
                    >
                      Edit
                    </button>
                    <button type="button" className={buttonClass} onClick={() => void remove("draft", draft.id)}>
                      Delete
                    </button>
                  </div>
                </article>
              ))}
          </div>

          <div className="h-fit rounded-xl border border-slate-500/25 bg-[var(--th-bg-surface)] p-5">
            <h2 className="text-lg font-semibold">
              {section === "contacts"
                ? contactId
                  ? "Edit contact"
                  : "Add contact"
                : section === "drafts"
                  ? draftId
                    ? "Edit draft"
                    : "New draft"
                  : workId
                    ? "Edit record"
                    : business === "tech"
                      ? "New service ticket"
                      : "New rental quote"}
            </h2>
            {section === "contacts" && (
              <form onSubmit={(event) => void saveContact(event)} className="mt-5 grid gap-4">
                <label className={labelClass}>
                  Name
                  <input
                    required
                    maxLength={160}
                    className={inputClass}
                    value={contactForm.name}
                    onChange={(event) => setContactForm({ ...contactForm, name: event.target.value })}
                  />
                </label>
                <label className={labelClass}>
                  Email
                  <input
                    type="email"
                    maxLength={320}
                    className={inputClass}
                    value={contactForm.email}
                    onChange={(event) => setContactForm({ ...contactForm, email: event.target.value })}
                  />
                </label>
                <label className={labelClass}>
                  Phone
                  <input
                    maxLength={80}
                    className={inputClass}
                    value={contactForm.phone}
                    onChange={(event) => setContactForm({ ...contactForm, phone: event.target.value })}
                  />
                </label>
                <label className={labelClass}>
                  Notes
                  <textarea
                    rows={4}
                    maxLength={4000}
                    className={inputClass}
                    value={contactForm.notes}
                    onChange={(event) => setContactForm({ ...contactForm, notes: event.target.value })}
                  />
                </label>
                <div className="flex gap-2">
                  <button type="submit" disabled={busy} className={primaryClass}>
                    {busy ? "Saving…" : "Save contact"}
                  </button>
                  {contactId && (
                    <button
                      type="button"
                      className={buttonClass}
                      onClick={() => {
                        setContactId(null);
                        setContactForm({ name: "", email: "", phone: "", notes: "" });
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </form>
            )}

            {section === "work" && (
              <form onSubmit={(event) => void saveWork(event)} className="mt-5 grid gap-4">
                <label className={labelClass}>
                  {business === "tech" ? "Ticket title" : "Event name"}
                  <input
                    required
                    maxLength={200}
                    className={inputClass}
                    value={workForm.title}
                    onChange={(event) => setWorkForm({ ...workForm, title: event.target.value })}
                  />
                </label>
                <label className={labelClass}>
                  Contact
                  <select
                    className={inputClass}
                    value={workForm.contact_id}
                    onChange={(event) => setWorkForm({ ...workForm, contact_id: event.target.value })}
                  >
                    <option value="">No linked contact</option>
                    {contacts.map((contact) => (
                      <option key={contact.id} value={contact.id}>
                        {contact.name}
                      </option>
                    ))}
                  </select>
                </label>
                {business === "tech" ? (
                  <label className={labelClass}>
                    Device or service
                    <input
                      maxLength={200}
                      className={inputClass}
                      value={workForm.device}
                      onChange={(event) => setWorkForm({ ...workForm, device: event.target.value })}
                    />
                  </label>
                ) : (
                  <label className={labelClass}>
                    Event date
                    <input
                      type="date"
                      className={inputClass}
                      value={workForm.event_date}
                      onChange={(event) => setWorkForm({ ...workForm, event_date: event.target.value })}
                    />
                  </label>
                )}
                <label className={labelClass}>
                  {business === "tech" ? "Problem and work notes" : "Requested rental items"}
                  <textarea
                    required
                    rows={5}
                    maxLength={8000}
                    className={inputClass}
                    value={workForm.details}
                    onChange={(event) => setWorkForm({ ...workForm, details: event.target.value })}
                  />
                </label>
                {business === "rental" && (
                  <label className={labelClass}>
                    Quote text
                    <textarea
                      rows={5}
                      maxLength={8000}
                      className={inputClass}
                      value={workForm.extra}
                      onChange={(event) => setWorkForm({ ...workForm, extra: event.target.value })}
                    />
                  </label>
                )}
                <div className="flex gap-2">
                  <button type="submit" disabled={busy} className={primaryClass}>
                    {busy ? "Saving…" : "Save record"}
                  </button>
                  {workId && (
                    <button
                      type="button"
                      className={buttonClass}
                      onClick={() => {
                        setWorkId(null);
                        setWorkForm({ contact_id: "", title: "", device: "", event_date: "", details: "", extra: "" });
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </form>
            )}

            {section === "drafts" && (
              <form onSubmit={(event) => void saveDraft(event)} className="mt-5 grid gap-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className={labelClass}>
                    Channel
                    <select
                      className={inputClass}
                      value={draftForm.channel}
                      onChange={(event) => setDraftForm({ ...draftForm, channel: event.target.value as DraftChannel })}
                    >
                      {channels.map((channel) => (
                        <option key={channel} value={channel}>
                          {channel}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={labelClass}>
                    Purpose
                    <select
                      className={inputClass}
                      value={draftForm.purpose}
                      onChange={(event) => setDraftForm({ ...draftForm, purpose: event.target.value as DraftPurpose })}
                    >
                      {purposes.map((purpose) => (
                        <option key={purpose} value={purpose}>
                          {displayStatus(purpose)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className={labelClass}>
                  Contact
                  <select
                    className={inputClass}
                    value={draftForm.contact_id}
                    onChange={(event) => setDraftForm({ ...draftForm, contact_id: event.target.value })}
                  >
                    <option value="">General audience</option>
                    {contacts.map((contact) => (
                      <option key={contact.id} value={contact.id}>
                        {contact.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={labelClass}>
                  Subject or post title
                  <input
                    maxLength={320}
                    className={inputClass}
                    value={draftForm.subject}
                    onChange={(event) => setDraftForm({ ...draftForm, subject: event.target.value })}
                  />
                </label>
                <label className={labelClass}>
                  Message
                  <textarea
                    required
                    rows={8}
                    maxLength={12000}
                    className={inputClass}
                    value={draftForm.body}
                    onChange={(event) => setDraftForm({ ...draftForm, body: event.target.value })}
                  />
                </label>
                <p className="text-xs text-[var(--th-text-secondary)]">
                  Ready marks a draft for your review. This workspace does not send messages or publish posts.
                </p>
                <div className="flex gap-2">
                  <button type="submit" disabled={busy} className={primaryClass}>
                    {busy ? "Saving…" : "Save draft"}
                  </button>
                  {draftId && (
                    <button
                      type="button"
                      className={buttonClass}
                      onClick={() => {
                        setDraftId(null);
                        setDraftForm({ contact_id: "", channel: "email", purpose: "outreach", subject: "", body: "" });
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
