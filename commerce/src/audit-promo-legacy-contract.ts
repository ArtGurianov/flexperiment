import { openReadOnlyDatabase } from "./db";
import { pricePromo, validatePromoTerms } from "./promo-pricing";

type Finding = { kind: string; id?: string; detail: string };
const database = openReadOnlyDatabase();
const findings: Finding[] = [];
const promos = database.prepare("SELECT id, code, normalized_code, discount_type, discount_value FROM promo_codes").all() as Array<Record<string, unknown>>;
const occurrences = database.prepare("SELECT id, price_kopecks FROM occurrences").all() as Array<Record<string, unknown>>;
for (const promo of promos) {
  const code = String(promo.code);
  if (!/^[A-Z0-9_-]{2,64}$/.test(code)) findings.push({ kind: "NONCANONICAL_CODE", id: String(promo.id), detail: code });
  if (String(promo.normalized_code) !== code.trim().toUpperCase()) findings.push({ kind: "NORMALIZED_CODE_MISMATCH", id: String(promo.id), detail: String(promo.normalized_code) });
  try { validatePromoTerms(promo.discount_type, promo.discount_value); }
  catch (error) { findings.push({ kind: (error as Error).message, id: String(promo.id), detail: "invalid terms" }); }
  for (const occurrence of occurrences) {
    try { pricePromo(Number(occurrence.price_kopecks), promo.discount_type, promo.discount_value); }
    catch (error) { findings.push({ kind: (error as Error).message, id: String(promo.id), detail: `occurrence=${occurrence.id}` }); }
  }
}
const normalizedCodes = new Map<string, string[]>();
for (const promo of promos) {
  const canonical = String(promo.code).trim().toUpperCase();
  normalizedCodes.set(canonical, [...(normalizedCodes.get(canonical) ?? []), String(promo.id)]);
}
for (const [code, ids] of normalizedCodes) if (ids.length > 1) findings.push({ kind: "NORMALIZATION_COLLISION", detail: `${code}: ${ids.join(",")}` });
for (const agent of database.prepare("SELECT id, slug FROM agents").all() as Array<{ id: string; slug: string }>) if (!/^[a-z0-9-]{2,100}$/.test(agent.slug)) findings.push({ kind: "NONCANONICAL_AGENT_SLUG", id: agent.id, detail: agent.slug });
const historicalPromoOrders = Number((database.prepare("SELECT COUNT(*) AS count FROM orders WHERE promo_code_snapshot IS NOT NULL").get() as { count: number }).count);
console.log(JSON.stringify({ findings, historical_promo_order_baseline: historicalPromoOrders }, null, 2));
database.close();
if (findings.length) process.exitCode = 1;
