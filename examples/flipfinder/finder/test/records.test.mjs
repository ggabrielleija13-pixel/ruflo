import { test } from "node:test";
import assert from "node:assert/strict";
import { mapFieldsByRules, addressKey, groupRecords, preScore, conditionByRules } from "../records.mjs";
import { download } from "../sources.mjs";

// Shapes modeled on Socrata exports; values are made up for the test.
const SPLIT = [
  { housenumber: "123", streetname: "MAIN STREET", zip: "10001", inspectiondate: "2026-09-01T00:00:00", novdescription: "Repair broken window", currentstatus: "OPEN" },
  { housenumber: "123", streetname: "Main St", zip: "10001", inspectiondate: "2026-08-01T00:00:00", novdescription: "Abate rodent infestation", currentstatus: "CLOSE" },
  { housenumber: "9", streetname: "Oak Ave", zip: "10002", inspectiondate: "2025-01-01T00:00:00", novdescription: "Paint hallway", currentstatus: "CLOSED" },
];
const FULL = [{ address: "123 Main St Apt 4", violation_description: "Building vacant and open to trespass", violation_status: "OPEN", violation_date: "2026-09-15" }];

test("maps split and full address columns by name", () => {
  assert.deepEqual(mapFieldsByRules(SPLIT).address, ["housenumber", "streetname"]);
  assert.equal(mapFieldsByRules(SPLIT).status, "currentstatus");
  assert.deepEqual(mapFieldsByRules(FULL).address, ["address"]);
});

test("address keys merge spelling variants and drop unit numbers", () => {
  assert.equal(addressKey("123 MAIN STREET", "NYC"), addressKey("123 Main St.", "nyc"));
  assert.equal(addressKey("123 Main St Apt 4"), addressKey("123 Main St"));
  assert.equal(addressKey("45 W 21st Street"), "45 w 21st st");
});

test("groups records into properties across datasets", () => {
  const props = groupRecords(SPLIT, mapFieldsByRules(SPLIT), { id: "a", city: "NYC", signal: "violation" });
  const full = FULL; // no zip column: still merges on street + city
  groupRecords(full, mapFieldsByRules(full), { id: "b", city: "NYC", signal: "violation" }, props);
  const main = props.get(addressKey("123 Main St", "NYC"));
  assert.equal(props.size, 2);
  assert.equal(main.violations, 3);
  assert.equal(main.open, 2);
  assert.equal(main.vacant, true);
  assert.equal(main.latest, "2026-09-15");
  assert.deepEqual(main.sources, ["a", "b"]);
  assert.equal(main.zip, "10001");
  assert.ok(preScore(main, Date.parse("2026-10-01")) > preScore(props.get(addressKey("9 Oak Ave", "NYC")), Date.parse("2026-10-01")));
  assert.equal(conditionByRules(main), 2);
});

test("builds a Socrata query and flattens nested fields", async () => {
  let asked;
  const fetchImpl = async (url) => { asked = url; return new Response(JSON.stringify([{ address: "1 A St", location: { latitude: "1" } }])); };
  const rows = await download({ label: "t", url: "https://x.gov/resource/abcd-1234.json", dateField: "d" }, { limit: 10, fetchImpl });
  assert.equal(asked.searchParams.get("$limit"), "10");
  assert.equal(asked.searchParams.get("$order"), "d DESC");
  assert.match(asked.searchParams.get("$where"), /^d > '\d{4}-\d{2}-\d{2}'$/);
  assert.deepEqual(rows, [{ address: "1 A St", "location.latitude": "1" }]);
});
