import { describe, expect, it } from "vitest";

import { headOf, readExport } from "./read-export";

/**
 * Asserted against the built HTML rather than against source, because a
 * resource hint that does not reach the static document is worth nothing: its
 * entire value is being visible to the preload scanner while the HTML is still
 * being parsed. React hoists these `<link>`s out of the body, and whether that
 * hoist survives the export is exactly what cannot be read off app/page.tsx.
 *
 * Why they exist: the Kinescope chain is strictly serial and begins only after
 * hydration. Measured on this export before these hints, the API script was
 * first requested at 2.5s, the embed iframe at 3.6s, and the backdrop did not
 * start playing until 6.3s. Every hop was a fresh connection to an origin the
 * document had never contacted.
 */
const KINESCOPE_ORIGINS = ["https://player.kinescope.io", "https://kinescope.io"] as const;

const PLAYER_API = "https://player.kinescope.io/latest/iframe.player.js";

describe("the home page's third-party resource hints", () => {
  const head = headOf(readExport("index.html"));

  it.each(KINESCOPE_ORIGINS)("preconnects to %s", (origin) => {
    expect(head).toMatch(new RegExp(`<link[^>]+rel="preconnect"[^>]+href="${origin}"`));
  });

  it("preloads the player API the first hop depends on", () => {
    // Without this the tag is only created from an effect, so the request
    // cannot start until the dynamic chunk has arrived and hydration has run.
    expect(head).toMatch(
      new RegExp(`<link[^>]+href="${PLAYER_API.replace(/[.]/g, "\\.")}"[^>]*>`),
    );
    expect(head).toContain('as="script"');
  });

  it("keeps the local backdrop still discoverable before the video exists", () => {
    // It is what every visitor looks at until the player starts, and every
    // reduced-motion or Save-Data visitor looks at permanently.
    expect(head).toMatch(/<link[^>]+rel="preload"[^>]+href="\/hero-backdrop\.webp"/);
  });
});

describe("pages that mount no player", () => {
  it.each(["refund.html", "ticket.html"])("does not preconnect from %s", (route) => {
    // The hints are the home page's, not the layout's. Paying for a connection
    // and a 60KB script on a route with no video would be a straight loss.
    const head = headOf(readExport(route));
    for (const origin of KINESCOPE_ORIGINS) expect(head).not.toContain(origin);
    expect(head).not.toContain(PLAYER_API);
  });
});
