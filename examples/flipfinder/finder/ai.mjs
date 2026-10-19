// Claude-powered steps: map unfamiliar dataset columns, and read each
// property's violation history to judge condition, vacancy and flip priority.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

const MODEL = process.env.FLIPFINDER_MODEL || "claude-opus-5-5";

/**
 * Returns a client, or null when no credentials can be found (AI steps are then skipped).
 * Credentials come from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
 */
export function makeClient() {
  try { return new Anthropic(); } catch { return null; }
}

/** True when an error means the AI can't be used at all (bad or missing credentials). */
export function isAuthError(err) {
  return err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError
    || /api ?key|credential|authenticat/i.test(String(err?.message ?? ""));
}

// Server-side fallback: if the model declines, the API retries on its default fallback model.
async function ask(client, { prompt, schema, effort, maxTokens = 16000 }) {
  const res = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: maxTokens,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort, format: betaZodOutputFormat(schema) },
    messages: [{ role: "user", content: prompt }],
  });
  if (res.stop_reason === "refusal") throw new Error("Claude declined this request.");
  if (res.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off; try a smaller --batch.");
  if (!res.parsed_output) throw new Error("Claude's answer did not match the expected format.");
  return res.parsed_output;
}

const FieldMapSchema = z.object({
  address: z.array(z.string()).describe("Field names that together form the street address, in order (e.g. house number then street name)."),
  city: z.string().nullable(),
  zip: z.string().nullable(),
  date: z.string().nullable().describe("Field with the date the violation or case was opened or issued."),
  description: z.array(z.string()).describe("Up to 3 fields describing the violation or complaint in words."),
  status: z.string().nullable().describe("Field saying whether the case is open or closed."),
});

/** Ask Claude which columns hold address, date, description and status. */
export async function mapFieldsWithClaude(client, label, sample) {
  const rows = sample.slice(0, 5).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v).slice(0, 80)])));
  const map = await ask(client, {
    effort: "low",
    maxTokens: 4000,
    schema: FieldMapSchema,
    prompt: `These are sample records from a public dataset: "${label}". Identify which field names hold each piece of information. Use only field names that appear in the records; use null (or an empty list) when none fits.

${JSON.stringify(rows, null, 1)}`,
  });
  const keys = new Set(sample.flatMap((r) => Object.keys(r)));
  const known = (f) => (f && keys.has(f) ? f : null);
  return {
    address: map.address.filter((f) => keys.has(f)),
    city: known(map.city), zip: known(map.zip), date: known(map.date), status: known(map.status),
    description: map.description.filter((f) => keys.has(f)).slice(0, 3),
  };
}

const AssessmentSchema = z.object({
  properties: z.array(z.object({
    id: z.number().int(),
    condition: z.number().int().min(1).max(5).describe("1 = needs gut rehab, 5 = cosmetic only"),
    likely_vacant: z.boolean(),
    single_family_likely: z.boolean().describe("False when the records point to a large apartment building, commercial or industrial site"),
    priority: z.number().int().min(0).max(100).describe("How promising as a fix-and-flip lead"),
    summary: z.string().describe("One or two plain sentences: what is wrong with the property and why it does or does not look like a flip"),
  })),
});

/**
 * Read violation histories and score each property as a flip lead.
 * @param {import("./records.mjs").Property[]} props
 */
export async function assessWithClaude(client, props, { batch = 20, onProgress = () => {} } = {}) {
  const out = new Map();
  for (let i = 0; i < props.length; i += batch) {
    const chunk = props.slice(i, i + batch);
    const data = chunk.map((p, j) => ({
      id: j, address: `${p.address}, ${p.city} ${p.zip}`.trim(), violation_records: p.violations, open: p.open,
      latest: p.latest, flagged_vacant: p.vacant, datasets: p.sources, descriptions: p.descriptions,
    }));
    const result = await ask(client, {
      effort: "medium",
      schema: AssessmentSchema,
      prompt: `You are a residential fix-and-flip acquisitions analyst screening public code-enforcement records for distressed, off-market houses.

For each property below, judge from the violation descriptions only (do not invent facts): its likely condition (1 = gut rehab, 5 = cosmetic), whether it is likely vacant, whether it looks like a house or small multifamily a flipper would buy (not a large apartment complex, commercial or industrial site), and a 0-100 priority as a flip lead. Distress that suggests a motivated owner (vacancy, many open violations, neglect over time) raises priority; properties that are not houses, or whose issues are trivial and already fixed, lower it. Return one entry per id.

${JSON.stringify(data)}`,
    });
    for (const a of result.properties) if (chunk[a.id]) out.set(chunk[a.id].key, a);
    onProgress(Math.min(i + batch, props.length), props.length);
  }
  return out;
}
