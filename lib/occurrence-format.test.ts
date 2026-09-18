import { describe, expect, it } from "vitest";

import {
  occurrenceCompactDateLabelInZone,
  occurrenceDateLabelInZone,
  occurrenceDateTimeLabel,
  occurrenceTimeLabelInZone,
  publicVenueDisclosure,
  type Occurrence,
} from "@/lib/occurrence-format";

/**
 * Two registers, and the boundary between them.
 *
 * An earlier pass made every date numeric, which is how the long form
 * disappeared from headings, detail panels and a refund confirmation that had
 * nothing to do with the catalogue. These tests pin both forms AND the fact
 * that they are different, so a future "let's unify the date format" reads as a
 * decision rather than as tidying.
 *
 * Both are zone-explicit, which is the harder property and the one with real
 * consequences: under `output: "export"` a formatter without a zone would bake
 * the CI runner's timezone into static HTML for every visitor.
 */
const INSTANT = "2026-09-25T10:00:00.000Z";

describe("the compact register — catalogue rows", () => {
  it("is numeric, and the only form allowed to be", () => {
    expect(occurrenceCompactDateLabelInZone(INSTANT, "Europe/Moscow")).toBe("25.09.2026");
    expect(occurrenceCompactDateLabelInZone("2030-03-14T11:00:00.000Z", "Asia/Novosibirsk")).toBe("14.03.2030");
  });

  it("answers in the occurrence's zone, not the machine's", () => {
    // One instant, two zones, two calendar days. A formatter reading the
    // ambient zone could not tell these apart, and a build would freeze
    // whichever one CI happened to be in.
    const evening = "2026-09-25T20:00:00.000Z";
    expect(occurrenceCompactDateLabelInZone(evening, "Europe/Moscow")).toBe("25.09.2026");
    expect(occurrenceCompactDateLabelInZone(evening, "Asia/Novosibirsk")).toBe("26.09.2026");
  });

  it("says so plainly rather than rendering Invalid Date", () => {
    expect(occurrenceCompactDateLabelInZone("not a date", "Europe/Moscow")).toBe("Дата уточняется");
  });
});

describe("the long register — headings, detail panels, confirmations", () => {
  it("spells the month out", () => {
    expect(occurrenceDateLabelInZone(INSTANT, "Europe/Moscow")).toBe("25 сентября 2026 г.");
    expect(occurrenceDateTimeLabel(INSTANT, "Europe/Moscow")).toBe("25 сентября 2026 г. в 13:00");
  });

  it("is the same zone-explicit instant as the compact one, said differently", () => {
    // The guarantee that matters: a catalogue row and the heading it links to
    // cannot name different days, however differently they spell the month.
    const evening = "2026-09-25T20:00:00.000Z";
    for (const zone of ["Europe/Moscow", "Asia/Novosibirsk"]) {
      const day = occurrenceCompactDateLabelInZone(evening, zone).slice(0, 2);
      expect(occurrenceDateLabelInZone(evening, zone).startsWith(day)).toBe(true);
    }
  });

  it("reaches the venue disclosure's announcement deadline", () => {
    const occurrence = {
      timezone: "Europe/Moscow",
      venue: {
        status: "TO_BE_ANNOUNCED",
        name: null,
        address: null,
        disclosure_text: "Площадка уточняется.",
        announce_by: "2026-09-20T14:00:00.000Z",
      },
    } as Occurrence;
    // A sentence a visitor reads once, and the mirror of one Commerce issues
    // server-side — which also spells the month out.
    expect(publicVenueDisclosure(occurrence)).toBe(
      "Площадка уточняется. Сообщим адрес участникам на email не позднее 20 сентября 2026 г. в 17:00.",
    );
  });

  it("stays plainly distinct from the compact register", () => {
    expect(occurrenceDateLabelInZone(INSTANT, "Europe/Moscow")).not.toBe(
      occurrenceCompactDateLabelInZone(INSTANT, "Europe/Moscow"),
    );
    expect(occurrenceDateLabelInZone(INSTANT, "Europe/Moscow")).not.toMatch(/\d\.\d/);
    expect(occurrenceCompactDateLabelInZone(INSTANT, "Europe/Moscow")).not.toMatch(/[а-я]/i);
  });
});

describe("occurrenceTimeLabelInZone", () => {
  it("is unchanged, and empty rather than wrong for a bad instant", () => {
    expect(occurrenceTimeLabelInZone(INSTANT, "Europe/Moscow")).toBe("13:00");
    expect(occurrenceTimeLabelInZone("nonsense", "Europe/Moscow")).toBe("");
  });
});
