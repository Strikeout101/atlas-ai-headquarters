import { del, patch, post, request } from "./core";

export type BusinessKind = "tech" | "rental";
export type DraftChannel = "email" | "social" | "sms";
export type DraftPurpose = "outreach" | "promotion" | "follow_up" | "checkin" | "checkout" | "general";

export interface BusinessContact {
  id: string;
  business: BusinessKind;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

export interface TechTicket {
  id: string;
  business: "tech";
  contact_id: string | null;
  title: string;
  device: string | null;
  description: string | null;
  status: "new" | "scheduled" | "active" | "waiting" | "done";
  created_at: number;
  updated_at: number;
}

export interface RentalQuote {
  id: string;
  business: "rental";
  contact_id: string | null;
  event_name: string;
  event_date: string | null;
  items: string;
  quote_text: string | null;
  status: "draft" | "shared" | "accepted" | "declined" | "archived";
  created_at: number;
  updated_at: number;
}

export interface CommunicationDraft {
  id: string;
  business: BusinessKind;
  contact_id: string | null;
  channel: DraftChannel;
  purpose: DraftPurpose;
  subject: string | null;
  body: string;
  status: "draft" | "ready" | "archived";
  created_at: number;
  updated_at: number;
}

type ListResponse<T> = { ok: true; items: T[] };
type ItemResponse<T> = { ok: true; item: T };

export const businessApi = {
  contacts: {
    list: async (business: BusinessKind) =>
      (await request<ListResponse<BusinessContact>>(`/api/business/contacts?business=${business}`)).items,
    create: async (
      input: Pick<BusinessContact, "business" | "name"> & Partial<Pick<BusinessContact, "email" | "phone" | "notes">>,
    ) => (await post<ItemResponse<BusinessContact>>("/api/business/contacts", input)).item,
    update: async (id: string, input: Partial<Pick<BusinessContact, "name" | "email" | "phone" | "notes">>) =>
      (await patch<ItemResponse<BusinessContact>>(`/api/business/contacts/${encodeURIComponent(id)}`, input)).item,
    remove: async (id: string) => del(`/api/business/contacts/${encodeURIComponent(id)}`),
  },
  tickets: {
    list: async () => (await request<ListResponse<TechTicket>>("/api/business/tickets")).items,
    create: async (
      input: Pick<TechTicket, "title" | "status"> & Partial<Pick<TechTicket, "contact_id" | "device" | "description">>,
    ) => (await post<ItemResponse<TechTicket>>("/api/business/tickets", input)).item,
    update: async (
      id: string,
      input: Partial<Pick<TechTicket, "contact_id" | "title" | "device" | "description" | "status">>,
    ) => (await patch<ItemResponse<TechTicket>>(`/api/business/tickets/${encodeURIComponent(id)}`, input)).item,
    remove: async (id: string) => del(`/api/business/tickets/${encodeURIComponent(id)}`),
  },
  quotes: {
    list: async () => (await request<ListResponse<RentalQuote>>("/api/business/quotes")).items,
    create: async (
      input: Pick<RentalQuote, "event_name" | "items" | "status"> &
        Partial<Pick<RentalQuote, "contact_id" | "event_date" | "quote_text">>,
    ) => (await post<ItemResponse<RentalQuote>>("/api/business/quotes", input)).item,
    update: async (
      id: string,
      input: Partial<Pick<RentalQuote, "contact_id" | "event_name" | "event_date" | "items" | "quote_text" | "status">>,
    ) => (await patch<ItemResponse<RentalQuote>>(`/api/business/quotes/${encodeURIComponent(id)}`, input)).item,
    remove: async (id: string) => del(`/api/business/quotes/${encodeURIComponent(id)}`),
  },
  drafts: {
    list: async (business: BusinessKind) =>
      (await request<ListResponse<CommunicationDraft>>(`/api/business/drafts?business=${business}`)).items,
    create: async (
      input: Pick<CommunicationDraft, "business" | "channel" | "purpose" | "body" | "status"> &
        Partial<Pick<CommunicationDraft, "contact_id" | "subject">>,
    ) => (await post<ItemResponse<CommunicationDraft>>("/api/business/drafts", input)).item,
    update: async (
      id: string,
      input: Partial<Pick<CommunicationDraft, "contact_id" | "channel" | "purpose" | "subject" | "body" | "status">>,
    ) => (await patch<ItemResponse<CommunicationDraft>>(`/api/business/drafts/${encodeURIComponent(id)}`, input)).item,
    remove: async (id: string) => del(`/api/business/drafts/${encodeURIComponent(id)}`),
  },
};
