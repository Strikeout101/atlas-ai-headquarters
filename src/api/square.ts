export type SquareConnection = {
  environment: "production" | "sandbox";
  token_configured: boolean;
  enabled: boolean;
  history_since: string;
  locations: Array<{ id: string; name: string; currency: string; status: string }>;
  mappings: Array<{ business: "tech" | "rental" | "ventures"; location_id: string }>;
  last_test_at: number | null;
  last_sync_at: number | null;
  last_sync_error: string | null;
  watermark: string | null;
  fee_unknown: number;
};
import { del, patch, post, put, request } from "./core";
export const getSquareSettings = () => request<{ ok: true; connection: SquareConnection }>("/api/square");
export const updateSquareSettings = (input: {
  environment?: "production" | "sandbox";
  token?: string;
  clear_token?: boolean;
  enabled?: boolean;
  history_since?: string;
}) => patch<{ ok: true; connection: SquareConnection }>("/api/square", input);
export const updateSquareMappings = (mappings: SquareConnection["mappings"]) =>
  put<{ ok: true; connection: SquareConnection }>("/api/square/mappings", { mappings });
export const testSquare = () => post<{ ok: true; connection: SquareConnection }>("/api/square/test", {});
export const syncSquare = () =>
  post<{ ok: true; imported: number; settings: SquareConnection }>("/api/square/sync", {});

/** One Square account. Primrose Events has its own; Small Business Tech and Eduardo Capital share another. */
export type SquareAccount = SquareConnection & { id: number; label: string; receipts: number };
type ConnectionInput = Parameters<typeof updateSquareSettings>[0] & { label?: string };
const connectionPath = (id: number) => `/api/square/connections/${encodeURIComponent(String(id))}`;
export const squareAccountsApi = {
  list: async () => (await request<{ ok: true; connections: SquareAccount[] }>("/api/square/connections")).connections,
  create: async (input: ConnectionInput) =>
    (await post<{ ok: true; connection: SquareAccount }>("/api/square/connections", input)).connection,
  update: async (id: number, input: ConnectionInput) =>
    (await patch<{ ok: true; connection: SquareAccount }>(connectionPath(id), input)).connection,
  mappings: async (id: number, mappings: SquareConnection["mappings"]) =>
    (await put<{ ok: true; connection: SquareAccount }>(`${connectionPath(id)}/mappings`, { mappings })).connection,
  test: async (id: number) =>
    (await post<{ ok: true; connection: SquareAccount }>(`${connectionPath(id)}/test`, {})).connection,
  sync: (id: number) => post<{ ok: true; imported: number; settings: SquareAccount }>(`${connectionPath(id)}/sync`, {}),
  remove: (id: number) => del(connectionPath(id)),
};
