import { toCents } from "./money.js";

/** Reads a costs CSV whose rows identify a product by id, url or exact title. */
export function parseCostsCsv(
  text: string,
  products: { externalId: string; url: string; title: string }[],
): { costs: Map<string, number>; unmatched: string[] } {
  const rows = text.trim().split(/\r?\n/).map(splitCsvLine);
  const header = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
  const keyCol = ["id", "external_id", "sku", "url", "title"].find((k) => header.includes(k));
  const costCol = header.findIndex((h) => h === "cost" || h === "unit_cost" || h === "cost_price");
  if (!keyCol || costCol < 0) throw new Error("The CSV needs a header with a cost column and one of: id, url, title.");
  const keyIdx = header.indexOf(keyCol);

  const byKey = new Map<string, string>();
  for (const p of products) {
    byKey.set(p.externalId, p.externalId);
    byKey.set(p.url.toLowerCase(), p.externalId);
    byKey.set(p.title.toLowerCase(), p.externalId);
  }
  const costs = new Map<string, number>();
  const unmatched: string[] = [];
  for (const row of rows) {
    const key = row[keyIdx]?.trim() ?? "";
    const cost = toCents(row[costCol]);
    const id = byKey.get(key) ?? byKey.get(key.toLowerCase());
    if (id && cost !== undefined) costs.set(id, cost);
    else if (key) unmatched.push(key);
  }
  return { costs, unmatched };
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
