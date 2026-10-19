#!/usr/bin/env node
// FlipFinder lead finder: downloads public distress records, merges them per
// property, has Claude judge each one, and writes a ranked CSV that the
// FlipFinder app imports (Import leads → CSV).
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { SOURCES, findSource, customSource, download } from "./sources.mjs";
import { mapFieldsByRules, isUsableMap, groupRecords, preScore, conditionByRules } from "./records.mjs";
import { makeClient, mapFieldsWithClaude, assessWithClaude, isAuthError } from "./ai.mjs";

const HELP = `Find distressed, off-market houses in public city records.

Usage:
  node find.mjs --source chicago-vacant --source chicago-violations
  node find.mjs --url https://data.example.gov/resource/abcd-1234.json --city Springfield

Options:
  --source <id>      A built-in source (repeatable). See --list.
  --url <url>        Any Socrata JSON endpoint or CSV of violations (repeatable).
  --vacant-url <url> Like --url, but every record means the property is vacant.
  --city <name>      City name for --url records that lack one.
  --limit <n>        Records to download per source (default 5000).
  --since-days <n>   Only records from the last n days, where the source has dates (default 365).
  --top <n>          How many top properties Claude assesses (default 60).
  --batch <n>        Properties per Claude request (default 20).
  --no-ai            Skip Claude; rank with rules only.
  --out <file>       Output CSV (default flipfinder-leads.csv).
  --list             Show built-in sources.

Claude needs ANTHROPIC_API_KEY (or an \`ant auth login\` profile). Without it the
tool still runs and ranks by rules.`;

const { values: opt } = parseArgs({
  options: {
    source: { type: "string", multiple: true, default: [] },
    url: { type: "string", multiple: true, default: [] },
    "vacant-url": { type: "string", multiple: true, default: [] },
    city: { type: "string", default: "" },
    limit: { type: "string", default: "5000" },
    "since-days": { type: "string", default: "365" },
    top: { type: "string", default: "60" },
    batch: { type: "string", default: "20" },
    "no-ai": { type: "boolean", default: false },
    out: { type: "string", default: "flipfinder-leads.csv" },
    list: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const log = (...a) => console.error(...a);

async function main() {
  if (opt.help) return console.log(HELP);
  if (opt.list) return SOURCES.forEach((s) => console.log(`${s.id.padEnd(20)} ${s.label} (${s.city}, ${s.state})`));

  const sources = [
    ...opt.source.map((id) => findSource(id) ?? fail(`Unknown source "${id}". Run with --list to see built-in sources.`)),
    ...opt.url.map((u) => ({ ...customSource(u, "violation"), city: opt.city })),
    ...opt["vacant-url"].map((u) => ({ ...customSource(u, "vacant"), city: opt.city })),
  ].map((s, i) => (s.id === "custom" ? { ...s, id: `url${i + 1}` } : s));
  if (!sources.length) fail("Pick at least one --source or --url. Run with --help for examples.");

  let client = opt["no-ai"] ? null : makeClient();
  if (!opt["no-ai"] && !client) log("No Claude credentials found; ranking with rules only.");
  const disableAi = (err) => {
    log(isAuthError(err) && /resolve authentication/i.test(err.message) ? "No Claude credentials found; ranking with rules only." : `Claude unavailable (${err.message}); continuing with rules only.`);
    client = null;
  };

  const props = new Map();
  for (const s of sources) {
    log(`Downloading ${s.label}…`);
    let records;
    try {
      records = await download(s, { limit: Number(opt.limit), sinceDays: Number(opt["since-days"]) });
    } catch (err) {
      log(`  Skipped: ${err.message}`);
      continue;
    }
    if (!records.length) { log("  No records returned."); continue; }
    let map = mapFieldsByRules(records);
    if (client) {
      try { map = await mapFieldsWithClaude(client, s.label, records); }
      catch (err) { if (isAuthError(err)) disableAi(err); else log(`  Claude could not map fields (${err.message}); using rules.`); }
    }
    if (!isUsableMap(map)) map = mapFieldsByRules(records);
    if (!isUsableMap(map)) { log(`  Skipped: no address column found in ${Object.keys(records[0]).join(", ")}`); continue; }
    const before = props.size;
    groupRecords(records, map, s, props);
    log(`  ${records.length} records → ${props.size - before} new properties (address from ${map.address.join(" + ")})`);
  }
  if (!props.size) fail("No properties found. Check the sources above for errors.");

  const ranked = [...props.values()].map((p) => ({ ...p, pre: preScore(p) })).sort((a, b) => b.pre - a.pre);
  const top = ranked.slice(0, Number(opt.top));
  let assessed = new Map();
  if (client) {
    log(`Claude is assessing the top ${top.length} of ${ranked.length} properties…`);
    try {
      assessed = await assessWithClaude(client, top, { batch: Number(opt.batch), onProgress: (n, t) => log(`  ${n}/${t}`) });
    } catch (err) {
      if (isAuthError(err)) disableAi(err); else log(`  Assessment stopped (${err.message}); unassessed rows keep rule scores.`);
    }
  }

  const rows = ranked.map((p) => {
    const a = assessed.get(p.key);
    return {
      address: p.address, city: p.city, zip: p.zip,
      code_violations: p.violations, open_violations: p.open,
      vacant: (a ? a.likely_vacant : p.vacant) ? "yes" : "no",
      condition: a ? a.condition : conditionByRules(p),
      house_likely: a ? (a.single_family_likely ? "yes" : "no") : "",
      lead_priority: a ? a.priority : p.pre,
      priority_by: a ? "claude" : "rules",
      latest_violation: p.latest, sources: p.sources.join(" "),
      notes: a ? a.summary : p.descriptions.slice(0, 3).join(" | "),
    };
  }).filter((r) => r.house_likely !== "no")
    .sort((x, y) => (y.priority_by === "claude") - (x.priority_by === "claude") || y.lead_priority - x.lead_priority);

  const cols = Object.keys(rows[0] ?? { address: "" });
  const cell = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  await writeFile(opt.out, [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n");
  log(`\nWrote ${rows.length} leads to ${opt.out}${assessed.size ? ` (${assessed.size} assessed by Claude)` : ""}.`);
  log("Open FlipFinder → Import leads (CSV) and choose this file. Add arv and mortgage_balance columns for full deal math.");
  for (const r of rows.slice(0, 5)) log(`  ${String(r.lead_priority).padStart(3)}  ${r.address}, ${r.city}  — ${r.notes.slice(0, 90)}`);
}

function fail(msg) { log(msg); process.exit(1); }

main().catch((err) => fail(`Error: ${err.message}`));
