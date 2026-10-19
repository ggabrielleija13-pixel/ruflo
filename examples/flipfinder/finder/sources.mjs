// Public open-data sources of property distress, and how to download them.
// Dataset ids come from each city's Socrata portal. Field names differ per
// city, so records are mapped to one shape by records.mjs (Claude or rules).

/** @typedef {{ id: string, city: string, state: string, label: string, url: string, signal: "violation" | "vacant", dateField?: string }} Source */

/** @type {Source[]} */
export const SOURCES = [
  {
    id: "chicago-violations", city: "Chicago", state: "IL", label: "Chicago building violations",
    url: "https://data.cityofchicago.org/resource/22u3-xenr.json", signal: "violation", dateField: "violation_date",
  },
  {
    id: "chicago-vacant", city: "Chicago", state: "IL", label: "Chicago vacant & abandoned building violations",
    url: "https://data.cityofchicago.org/resource/kc9i-wq85.json", signal: "vacant", dateField: "issued_date",
  },
  {
    id: "nyc-hpd", city: "New York", state: "NY", label: "NYC HPD housing maintenance violations",
    url: "https://data.cityofnewyork.us/resource/wvxf-dwi5.json", signal: "violation", dateField: "inspectiondate",
  },
  {
    id: "austin-code", city: "Austin", state: "TX", label: "Austin code enforcement cases",
    url: "https://data.austintexas.gov/resource/6wtj-zbtb.json", signal: "violation",
  },
  {
    id: "sf-dbi", city: "San Francisco", state: "CA", label: "San Francisco building complaints",
    url: "https://data.sfgov.org/resource/gm2e-bten.json", signal: "violation", dateField: "date_filed",
  },
];

export function findSource(id) {
  return SOURCES.find((s) => s.id === id) ?? null;
}

/** A source for any Socrata JSON endpoint or CSV URL the user passes with --url. */
export function customSource(url, signal = "violation") {
  const u = new URL(url);
  return { id: "custom", city: "", state: "", label: u.hostname + u.pathname, url, signal };
}

/**
 * Download up to `limit` records, newest first when the source names its date field.
 * Socrata endpoints take $limit/$order/$where; a CSV URL is downloaded whole.
 * @param {Source} source
 * @param {{ limit?: number, sinceDays?: number, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<Record<string, string>[]>}
 */
export async function download(source, { limit = 5000, sinceDays = 365, fetchImpl = fetch } = {}) {
  const url = new URL(source.url);
  const isCsv = url.pathname.endsWith(".csv");
  if (!isCsv && url.pathname.includes("/resource/")) {
    url.searchParams.set("$limit", String(limit));
    if (source.dateField) {
      url.searchParams.set("$order", `${source.dateField} DESC`);
      const since = new Date(Date.now() - sinceDays * 864e5).toISOString().slice(0, 10);
      url.searchParams.set("$where", `${source.dateField} > '${since}'`);
    }
  }
  const res = await fetchImpl(url, { headers: { Accept: isCsv ? "text/csv" : "application/json" } });
  if (!res.ok) throw new Error(`${source.label}: HTTP ${res.status} from ${url.host}`);
  if (isCsv) return parseCsvObjects(await res.text()).slice(0, limit);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error(`${source.label}: expected a JSON array of records`);
  return body.map((rec) => flatten(rec));
}

// Socrata returns nested location objects; flatten to string values.
function flatten(rec, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(rec ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else if (v != null) out[key] = String(v);
  }
  return out;
}

export function parseCsv(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(f); f = ""; if (row.some((v) => v.trim())) rows.push(row); row = [];
    } else f += c;
  }
  row.push(f); if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}

function parseCsvObjects(text) {
  const [head, ...rows] = parseCsv(text);
  if (!head) return [];
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}
