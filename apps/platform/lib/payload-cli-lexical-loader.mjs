// Narrow backport of Payload 3.x PR #18398. CLI only; no editor/data migration.
// https://github.com/payloadcms/payload/pull/18398
let environmentCondition;
export function initialize(condition) { environmentCondition = condition; }
export function resolve(specifier, context, nextResolve) {
  if ((specifier === "lexical" || specifier.startsWith("lexical/") || specifier.startsWith("@lexical/"))
    && !context.conditions.includes("development") && !context.conditions.includes("production")) {
    return nextResolve(specifier, { ...context, conditions: [...context.conditions, environmentCondition] });
  }
  return nextResolve(specifier, context);
}
