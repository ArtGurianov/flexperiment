import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useReconciledSchedule } from "./useReconciledSchedule";
import { toScheduleViewModel } from "@/lib/seo/schedule-view-model";
import { publicOccurrence, seoOccurrence } from "@/lib/seo/public-occurrence-fixture";

/**
 * The stale-while-revalidate contract, especially the part that costs money:
 * a landing visitor who never opens the catalogue must issue no Commerce
 * request at all.
 */
const initial = () => toScheduleViewModel([seoOccurrence()]);

function Probe({ enabled, onModel }: { enabled: boolean; onModel: (m: unknown) => void }) {
  onModel(useReconciledSchedule(initial(), enabled));
  return null;
}

const tourCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes("/v1/public/tour")).length;

describe("useReconciledSchedule", () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("issues no request at all while disabled", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const models: unknown[] = [];
    render(<Probe enabled={false} onModel={(m) => models.push(m)} />);

    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).not.toHaveBeenCalled();
    // And the snapshot is what renders.
    expect(models.at(-1)).toEqual(initial());
  });

  it("renders the snapshot immediately and reconciles after a successful read", async () => {
    const live = publicOccurrence({ id: seoOccurrence().id, price_kopecks: 999900 });
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ cities: [live] }) }) as Response);
    global.fetch = fetchMock as unknown as typeof fetch;
    const models: { cities: { upcoming: { priceLabel: string }[] }[] }[] = [];
    render(<Probe enabled onModel={(m) => models.push(m as never)} />);

    // First paint is the snapshot — the drawer never waits on the network.
    expect(models[0].cities[0].upcoming[0].priceLabel).toBe(initial().cities[0].upcoming[0].priceLabel);
    // Intl.NumberFormat separates groups with a narrow no-break space, so both
    // sides have to be flattened or "9 999" never matches "9 999".
    const flat = (value: string) => value.replace(/\s+/g, " ");
    await waitFor(() => expect(flat(models.at(-1)!.cities[0].upcoming[0].priceLabel)).toContain("9 999"));
  });

  it("moves BOTH date registers when a live read moves the date", async () => {
    // The model carries the same instant twice — «25 сентября 2026 г.» for the
    // headings and «25.09.2026» for the catalogue row. A liveFormat that
    // rewrote one and not the other would leave the row a visitor clicks and
    // the heading they land on naming different days, which is the exact class
    // of drift this model exists to prevent.
    const moved = publicOccurrence({
      id: seoOccurrence().id,
      starts_at: "2031-12-31T09:00:00.000Z",
      ends_at: "2031-12-31T11:00:00.000Z",
      timezone: "Europe/Moscow",
    });
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ cities: [moved] }) }) as Response) as unknown as typeof fetch;
    const models: { cities: { upcoming: { dateLabel: string; compactDateLabel: string }[] }[] }[] = [];
    render(<Probe enabled onModel={(m) => models.push(m as never)} />);

    await waitFor(() => {
      const event = models.at(-1)!.cities[0].upcoming[0];
      expect(event.compactDateLabel).toBe("31.12.2031");
      expect(event.dateLabel).toBe("31 декабря 2031 г.");
    });
  });

  it("keeps the snapshot when the read fails", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    const models: unknown[] = [];
    render(<Probe enabled onModel={(m) => models.push(m)} />);

    await new Promise((r) => setTimeout(r, 40));
    expect(models.at(-1)).toEqual(initial());
  });

  it("keeps the snapshot when the response does not match the contract", async () => {
    // A shape this code does not understand must leave the snapshot standing
    // rather than half-apply.
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ nonsense: true }) }) as Response) as unknown as typeof fetch;
    const models: unknown[] = [];
    render(<Probe enabled onModel={(m) => models.push(m)} />);

    await new Promise((r) => setTimeout(r, 40));
    expect(models.at(-1)).toEqual(initial());
  });

  it("preserves an earlier correction when a later read fails", async () => {
    // The no-revert consequence, stated explicitly: "snapshot stands" is true
    // only until the first success. Afterwards a failing read must not replace
    // a value known to be newer with one known to be older.
    const live = publicOccurrence({ id: seoOccurrence().id, price_kopecks: 999900 });
    let succeed = true;
    global.fetch = vi.fn(async () =>
      succeed
        ? ({ ok: true, json: async () => ({ cities: [live] }) } as Response)
        : ({ ok: false, json: async () => ({}) } as Response),
    ) as unknown as typeof fetch;

    const models: { cities: { upcoming: { priceLabel: string }[] }[] }[] = [];
    const flat = (value: string) => value.replace(/\s+/g, " ");
    const { rerender } = render(<Probe enabled onModel={(m) => models.push(m as never)} />);
    await waitFor(() => expect(flat(models.at(-1)!.cities[0].upcoming[0].priceLabel)).toContain("9 999"));

    // Close, then reopen with Commerce now failing.
    succeed = false;
    rerender(<Probe enabled={false} onModel={(m) => models.push(m as never)} />);
    await new Promise((r) => setTimeout(r, 10));
    rerender(<Probe enabled onModel={(m) => models.push(m as never)} />);
    await new Promise((r) => setTimeout(r, 40));

    expect(flat(models.at(-1)!.cities[0].upcoming[0].priceLabel)).toContain("9 999");
  });

  it("reads once per flow, not once per transition, and re-arms after a close", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ cities: [] }) }) as Response);
    global.fetch = fetchMock as unknown as typeof fetch;
    const { rerender } = render(<Probe enabled onModel={() => {}} />);
    await waitFor(() => expect(tourCalls(fetchMock)).toBe(1));

    // Staying open through schedule -> event -> schedule must not refetch: the
    // data cannot have become more current between two clicks a second apart.
    rerender(<Probe enabled onModel={() => {}} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(tourCalls(fetchMock)).toBe(1);

    // A full close re-arms; reopening later is a genuine new visit.
    rerender(<Probe enabled={false} onModel={() => {}} />);
    await new Promise((r) => setTimeout(r, 10));
    rerender(<Probe enabled onModel={() => {}} />);
    await waitFor(() => expect(tourCalls(fetchMock)).toBe(2));
  });
});
