import { toCents } from "./money.js";
import type { ProductEconomics } from "./types.js";

const COST_COLUMNS = ["cost", "unit_cost", "cost_price", "cogs"];
const UNITS_COLUMNS = ["units_per_week", "weekly_units", "units", "sales_per_week"];

/**
 * Reads a CSV of the merchant's product economics. Rows identify a product by
 * id, url or exact title, and give a unit cost, weekly unit sales, or both.
 */
export function parseEconomicsCsv(
  text: string,
  products: { externalId: string; url: string; title: string }[],
): { economics: Map<string, ProductEconomics>; unmatched: string[] } {
  const rows = text.trim().split(/\r?\n/).map(splitCsvLine);
  const header = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
  const keyCol = ["id", "external_id", "sku", "url", "title"].find((k) => header.includes(k));
  const costCol = header.findIndex((h) => COST_COLUMNS.includes(h));
  const unitsCol = header.findIndex((h) => UNITS_COLUMNS.includes(h));
  if (!keyCol || (costCol < 0 && unitsCol < 0)) {
    throw new Error("The CSV needs a header with one of: id, url, title, plus a cost column, a units_per_week column, or both.");
  }
  const keyIdx = header.indexOf(keyCol);

  const byKey = new Map<string, string>();
  for (const p of products) {
    byKey.set(p.externalId, p.externalId);
    byKey.set(p.url.toLowerCase(), p.externalId);
    byKey.set(p.title.toLowerCase(), p.externalId);
  }
  const economics = new Map<string, ProductEconomics>();
  const unmatched: string[] = [];
  for (const row of rows) {
    const key = row[keyIdx]?.trim() ?? "";
    const id = byKey.get(key) ?? byKey.get(key.toLowerCase());
    const costCents = costCol >= 0 ? toCents(row[costCol]) : undefined;
    const units = unitsCol >= 0 ? Number(row[unitsCol]?.trim()) : NaN;
    const unitsPerWeek = Number.isFinite(units) && row[unitsCol]?.trim() ? units : undefined;
    if (id && (costCents !== undefined || unitsPerWeek !== undefined)) economics.set(id, { costCents, unitsPerWeek });
    else if (key) unmatched.push(key);
  }
  return { economics, unmatched };
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
