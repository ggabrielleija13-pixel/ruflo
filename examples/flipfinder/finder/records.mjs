// Turns raw open-data records into one row per property.

/**
 * Which raw fields hold each piece of a record. `address` lists the fields
 * joined in order (some cities split house number and street name).
 * @typedef {{ address: string[], city: string|null, zip: string|null, date: string|null, description: string[], status: string|null }} FieldMap
 */

/**
 * @typedef {{ key: string, address: string, city: string, zip: string, violations: number, open: number,
 *   vacant: boolean, latest: string, descriptions: string[], sources: string[] }} Property
 */

const PATTERNS = {
  number: /^(house_?(number|no)|housenumber|street_?number|st_?num|address_?number|lowhousenumber)$/i,
  street: /^(street_?name|streetname|street|st_?name|street_?address)$/i,
  address: /^(address|property_?address|site_?address|situs_?address|location_?address|full_?address|block_?address|address_?full|violation_?address)$/i,
  city: /^(city|property_?city|boro|borough|municipality)$/i,
  zip: /^(zip|zip_?code|zipcode|postcode|postal_?code|zip5)$/i,
  date: /(violation_?date|inspection_?date|issued_?date|date_?filed|opened|open_?date|case_?date|created_?date|date)$/i,
  description: /(description|violation_?desc|violation_?code_?desc|novdescription|complaint|nature|violation_?type|inspector_?comments|case_?type)/i,
  status: /^(status|violation_?status|case_?status|currentstatus|current_?status|disposition)$/i,
};

/** Rule-based field mapping from column names alone. */
export function mapFieldsByRules(sample) {
  const keys = [...new Set(sample.flatMap((r) => Object.keys(r)))].filter((k) => !k.includes("."));
  const pick = (re) => keys.find((k) => re.test(k)) ?? null;
  const number = pick(PATTERNS.number), street = pick(PATTERNS.street), full = pick(PATTERNS.address);
  const address = full ? [full] : [number, street].filter(Boolean);
  return {
    address,
    city: pick(PATTERNS.city),
    zip: pick(PATTERNS.zip),
    date: pick(PATTERNS.date),
    description: keys.filter((k) => PATTERNS.description.test(k)).slice(0, 3),
    status: pick(PATTERNS.status),
  };
}

export function isUsableMap(map) {
  return Array.isArray(map?.address) && map.address.length > 0;
}

const SUFFIX = { street: "st", avenue: "ave", boulevard: "blvd", road: "rd", drive: "dr", place: "pl", court: "ct", lane: "ln", parkway: "pkwy", terrace: "ter" };
const DIR = { north: "n", south: "s", east: "e", west: "w" };

/** Normalized address key so the same house from two datasets merges (ZIP is often missing, so city is used). */
export function addressKey(address, city = "") {
  const words = String(address).toLowerCase().replace(/[.,#]/g, " ").split(/\s+/).filter(Boolean)
    .map((w) => SUFFIX[w] ?? DIR[w] ?? w)
    .filter((w) => !/^(apt|unit|ste|fl)$/.test(w));
  const unitAt = words.findIndex((w, i) => i > 1 && /^\d+[a-z]?$/.test(w) && !/^\d+(st|nd|rd|th)$/.test(w));
  return (unitAt > 0 ? words.slice(0, unitAt) : words).join(" ") + (city ? "|" + String(city).toLowerCase().trim() : "");
}

const OPEN_STATUS = /open|active|pending|issued|non.?compl|not.?compl|failed|referred|hearing/i;
const CLOSED_STATUS = /closed|complied|resolved|dismiss|abated|cancel|void|compliance/i;
const VACANT_WORDS = /vacant|abandon|boarded|unsecured|open to (the )?(weather|entry|trespass)|squatter|unoccupied/i;

/**
 * Group mapped records into properties.
 * @param {Record<string,string>[]} records
 * @param {FieldMap} map
 * @param {{ id: string, city: string, signal: string }} source
 * @param {Map<string, Property>} into
 */
export function groupRecords(records, map, source, into = new Map()) {
  for (const r of records) {
    const address = map.address.map((f) => r[f] ?? "").join(" ").replace(/\s+/g, " ").trim();
    if (!/\d/.test(address) || address.length < 5) continue;
    const zip = map.zip ? (r[map.zip] ?? "").slice(0, 5) : "";
    const city = (map.city && r[map.city]) || source.city || "";
    const key = addressKey(address, city);
    const p = into.get(key) ?? {
      key, address: titleCase(address), city, zip,
      violations: 0, open: 0, vacant: false, latest: "", descriptions: [], sources: [],
    };
    const desc = map.description.map((f) => r[f]).filter(Boolean).join(" — ").slice(0, 240);
    const status = map.status ? r[map.status] ?? "" : "";
    const date = map.date ? (r[map.date] ?? "").slice(0, 10) : "";
    p.violations += 1;
    if (OPEN_STATUS.test(status) || (!status && !CLOSED_STATUS.test(desc))) p.open += 1;
    if (source.signal === "vacant" || VACANT_WORDS.test(desc)) p.vacant = true;
    if (date > p.latest) p.latest = date;
    if (desc && p.descriptions.length < 12 && !p.descriptions.includes(desc)) p.descriptions.push(desc);
    if (!p.zip && zip) p.zip = zip;
    if (!p.sources.includes(source.id)) p.sources.push(source.id);
    into.set(key, p);
  }
  return into;
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(\d+)(St|Nd|Rd|Th)\b/g, (m, n, x) => n + x.toLowerCase());
}

/** Rule-based pre-rank so the AI looks at the most distressed properties first. */
export function preScore(p, now = Date.now()) {
  const ageDays = p.latest ? (now - new Date(p.latest).getTime()) / 864e5 : 999;
  const recency = ageDays < 90 ? 10 : ageDays < 365 ? 5 : 0;
  return Math.min(100, p.violations * 3 + p.open * 5 + (p.vacant ? 25 : 0) + recency + (p.sources.length > 1 ? 10 : 0));
}

/** Condition 1 (gut) to 5 (cosmetic) guessed from violation wording, used when the AI is off. */
export function conditionByRules(p) {
  const text = p.descriptions.join(" ").toLowerCase();
  if (/fire|collapse|structural|unsafe|dangerous|condemn|foundation/.test(text)) return 1;
  if (/roof|water damage|mold|plumbing|electrical|heat|boiler|sewage|rodent|infest/.test(text)) return 2;
  if (p.open >= 5 || p.vacant) return 2;
  if (/paint|window|door|porch|gutter|siding|stair/.test(text)) return 3;
  return 4;
}
