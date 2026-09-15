import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import EventStructuredData from "@/components/EventStructuredData";
import HomeStructuredData from "@/components/HomeStructuredData";
import { serializeJsonLd } from "@/lib/seo/json-ld";
import { seoOccurrence } from "@/lib/seo/public-occurrence-fixture";

/**
 * JSON-LD must not be able to close its own <script> element.
 *
 * Rendered to real markup rather than inspected as a data structure, because
 * the defect only exists at the HTML layer: `JSON.stringify` produces perfectly
 * valid JSON containing a literal `</script>`, and it is the HTML parser, not
 * the JSON parser, that ends the element there.
 *
 * Both components are sync server components, so calling them as plain
 * functions and handing the element to renderToStaticMarkup gives the exact
 * string the export writes — no build required.
 */
const HOSTILE = '</script><script>alert(1)</script>';

const markupFor = (element: React.ReactElement | null) =>
  element === null ? "" : renderToStaticMarkup(element);

describe("serializeJsonLd", () => {
  it("escapes every < as \\u003c, losslessly", () => {
    const serialized = serializeJsonLd({ name: HOSTILE });
    expect(serialized).not.toContain("<");
    expect(serialized).toContain("\\u003c");
    // Lossless: a consumer parsing it back sees the original string, so this is
    // an encoding change and not sanitisation that mangles real content.
    expect(JSON.parse(serialized)).toEqual({ name: HOSTILE });
  });

  it("is what JSON.stringify alone would not do", () => {
    // Guards the premise: if this ever stops being true the helper is no longer
    // earning its place.
    expect(JSON.stringify({ name: HOSTILE })).toContain("</script>");
  });
});

describe("Event structured data", () => {
  it("cannot be broken out of by an occurrence title, city or venue", () => {
    // Every one of these is Commerce-controlled and reaches the snapshot from
    // an operator-editable admin surface.
    const markup = markupFor(
      EventStructuredData({
        occurrence: seoOccurrence({
          title: HOSTILE,
          city_title: "Новосибирск",
          venue: { status: "CONFIRMED", name: HOSTILE, address: HOSTILE },
        }),
      }),
    );

    const blocks = markup.split("</script>");
    // Exactly one closing tag: the element's own, at the very end.
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toBe("");

    const payload = markup.slice(markup.indexOf(">") + 1, markup.lastIndexOf("</script>"));
    expect(payload).not.toContain("<");
    // And it is still the real value once parsed.
    expect((JSON.parse(payload) as { name: string }).name).toContain(HOSTILE);
  });

  it("round-trips ordinary Cyrillic content untouched", () => {
    const markup = markupFor(EventStructuredData({ occurrence: seoOccurrence() }));
    const payload = markup.slice(markup.indexOf(">") + 1, markup.lastIndexOf("</script>"));
    const event = JSON.parse(payload) as { name: string; location: { name: string } };
    expect(event.name).toBe("FLEXPERIMENT — Новосибирск");
    expect(event.location.name).toBe("Студия");
  });
});

describe("Organization structured data", () => {
  it("goes through the same serializer even though its values are literals", () => {
    const markup = markupFor(HomeStructuredData());
    const payload = markup.slice(markup.indexOf(">") + 1, markup.lastIndexOf("</script>"));
    expect(payload).not.toContain("<");
    expect(markup.split("</script>")).toHaveLength(2);
  });
});
