import { describe, expect, it } from "vitest";

import {
  occurrenceDateLabelInZone,
  occurrenceDateTimeLabel,
  occurrenceTimeLabelInZone,
  publicVenueDisclosure,
  type Occurrence,
} from "@/lib/occurrence-format";

/**
 * The public site's date format, pinned.
 *
 * Two independent properties, and both have already been the site of a defect:
 *
 *   FORM — numeric DD.MM.YYYY. The catalogue rows restored from c7d897b are a
 *   compact picker, and «Санкт-Петербург × 25 сентября 2026 г.» wraps to two
 *   lines at 390px where «Санкт-Петербург × 25.09.2026» does not. The audience
 *   is Russia only, where DD.MM is the written form and MM.DD is not in use, so
 *   the ambiguity that would forbid this internationally does not apply.
 *
 *   ZONE — the occurrence's own, never the ambient one. This is the harder half
 *   and the reason `occurrenceDateLabel` may not be reused on a prerendered
 *   surface: under `output: "export"` the ambient zone is the CI runner's, and
 *   it would be frozen into static HTML for every visitor.
 */
describe("occurrenceDateLabelInZone", () => {
  it("is numeric and compact, never a spelled-out month", () => {
    expect(occurrenceDateLabelInZone("2026-09-25T10:00:00.000Z", "Europe/Moscow")).toBe("25.09.2026");
    expect(occurrenceDateLabelInZone("2030-03-14T11:00:00.000Z", "Asia/Novosibirsk")).toBe("14.03.2030");
  });

  it("answers in the occurrence's zone, not the machine's", () => {
    // One instant, two zones, two calendar days. A formatter reading the
    // ambient zone could not tell these apart, and a build would freeze
    // whichever one CI happened to be in.
    const instant = "2026-09-25T20:00:00.000Z";
    expect(occurrenceDateLabelInZone(instant, "Europe/Moscow")).toBe("25.09.2026");
    expect(occurrenceDateLabelInZone(instant, "Asia/Novosibirsk")).toBe("26.09.2026");
  });

  it("says so plainly rather than rendering Invalid Date", () => {
    expect(occurrenceDateLabelInZone("not a date", "Europe/Moscow")).toBe("Дата уточняется");
  });
});

describe("occurrenceDateTimeLabel", () => {
  it("carries the same numeric date, with the time of day", () => {
    expect(occurrenceDateTimeLabel("2026-09-25T10:00:00.000Z", "Europe/Moscow")).toBe("25.09.2026, 13:00");
  });

  it("and its date half agrees with the date-only label", () => {
    // The two are shown on the same screens — the event page's «Дата и время»
    // beside a catalogue row — so a divergence in format would read as a
    // divergence in fact.
    const instant = "2026-10-02T04:00:00.000Z";
    const zone = "Asia/Novosibirsk";
    expect(occurrenceDateTimeLabel(instant, zone).startsWith(occurrenceDateLabelInZone(instant, zone))).toBe(true);
  });

  it("reaches the venue disclosure's announcement deadline too", () => {
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
    expect(publicVenueDisclosure(occurrence)).toBe(
      "Площадка уточняется. Сообщим адрес участникам на email не позднее 20.09.2026, 17:00.",
    );
  });
});

describe("occurrenceTimeLabelInZone", () => {
  it("is unchanged, and empty rather than wrong for a bad instant", () => {
    expect(occurrenceTimeLabelInZone("2026-09-25T10:00:00.000Z", "Europe/Moscow")).toBe("13:00");
    expect(occurrenceTimeLabelInZone("nonsense", "Europe/Moscow")).toBe("");
  });
});
