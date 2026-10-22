/** Parses "12.50", "1,299.00", "$12", 12.5 or "12,50" (decimal comma) into cents. */
export function toCents(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 100) : undefined;
  if (typeof value !== "string") return undefined;
  let s = value.replace(/[^\d.,-]/g, "");
  if (!s) return undefined;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) {
    // "1.299,00" or "12,50": comma is the decimal separator when followed by 1-2 digits.
    s = /,\d{1,2}$/.test(s) ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else {
    s = s.replace(/,/g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
}

export function formatCents(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return (cents / 100).toFixed(2);
  }
}

export function percentChange(before: number, after: number): number {
  return before === 0 ? 0 : ((after - before) / before) * 100;
}
