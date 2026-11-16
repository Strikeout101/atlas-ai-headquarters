export function currencyDigits(currency: string): number {
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}
/** Decimal text is converted with integers so 0.29 never becomes 28 cents. */
export function parseMoney(value: string, currency: string): number {
  const digits = currencyDigits(currency);
  const match = value.trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!match || (match[2]?.length ?? 0) > digits)
    throw new Error(`Enter a nonnegative amount with at most ${digits} decimal places for ${currency}.`);
  const minor = BigInt(match[1]) * 10n ** BigInt(digits) + BigInt((match[2] ?? "").padEnd(digits, "0") || "0");
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("This amount is too large to record safely.");
  return Number(minor);
}
export function moneyInput(minor: number, currency: string): string {
  const digits = currencyDigits(currency);
  const value = BigInt(minor);
  const scale = 10n ** BigInt(digits);
  return digits ? `${value / scale}.${String(value % scale).padStart(digits, "0")}` : String(value);
}
export function formatMoney(minor: number, currency: string, locale: string): string {
  if (!Number.isSafeInteger(minor)) throw new Error("Financial amount is not a safe integer.");
  const digits = currencyDigits(currency);
  const value = BigInt(minor);
  const magnitude = value < 0n ? -value : value;
  const scale = 10n ** BigInt(digits);
  const whole = magnitude / scale;
  const signedWhole = value < 0n ? (whole === 0n ? -0 : -whole) : whole;
  const fraction = new Intl.NumberFormat(locale, {
    useGrouping: false,
    minimumIntegerDigits: Math.max(1, digits),
    maximumFractionDigits: 0,
  }).format(magnitude % scale);
  return new Intl.NumberFormat(locale, { style: "currency", currency })
    .formatToParts(signedWhole)
    .map((part) => (part.type === "fraction" ? fraction : part.value))
    .join("");
}
