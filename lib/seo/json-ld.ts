/**
 * The one sanctioned way to put JSON-LD into a `<script>` element.
 *
 * `JSON.stringify` escapes what JSON needs escaped, and HTML is not JSON: the
 * two-character sequence `</script>` survives it intact, and inside a
 * `<script>` element the HTML parser ends the element at that sequence
 * regardless of the JavaScript or JSON context it appears in. A venue name or
 * event title carrying `</script><script>…` would therefore close the JSON-LD
 * block and open a real one.
 *
 * Escaping `<` as its JSON unicode form is sufficient and lossless: `<`
 * parses back to `<`, so every consumer sees the original string, while the
 * HTML parser can no longer find a closing tag. This is the escape Next's own
 * JSON-LD guide recommends
 * (node_modules/next/dist/docs/01-app/02-guides/json-ld.md), which states
 * plainly that `JSON.stringify` "does not sanitize malicious strings used in
 * XSS injection".
 *
 * This matters here because the event graph is built from Commerce-controlled
 * strings — `title`, `city_title`, `venue.name`, `venue.address` — that reach
 * the snapshot from an operator-editable admin surface. They are not hostile
 * input today; they are simply not this module's to trust.
 *
 * Applied to the Organization graph too, even though every value there is a
 * literal in this repository. A serializer that is only safe at some call sites
 * is one refactor away from being unsafe at all of them.
 */
export const serializeJsonLd = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, "\\u003c");
