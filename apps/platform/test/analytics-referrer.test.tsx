// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeAnalyticsReferrer } from "../lib/analytics-consent";

const { pathname } = vi.hoisted(() => ({ pathname: { current: "/courses/one" } }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));

type Command = [number, string, ...unknown[]];
const commands = () => ((window as unknown as { ym?: { a?: Command[] } }).ym?.a ?? []);

describe("Metrika referrer sanitization", () => {
  it("keeps only origin and path, and hides private paths", () => {
    expect(safeAnalyticsReferrer("https://mail.example/inbox?email=a%40b.ru&token=x#frag")).toBe("https://mail.example/inbox");
    expect(safeAnalyticsReferrer("https://flexperiment.ru/account?rt=secret")).toBe("https://flexperiment.ru/");
    expect(safeAnalyticsReferrer("https://flexperiment.ru/admin/v2")).toBe("https://flexperiment.ru/");
    expect(safeAnalyticsReferrer("")).toBeUndefined();
    expect(safeAnalyticsReferrer("javascript:alert(1)")).toBeUndefined();
    expect(safeAnalyticsReferrer("not a url")).toBeUndefined();
  });
});

describe("AnalyticsConsentManager hits", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_YANDEX_METRIKA_ID", "12345");
    Object.defineProperty(document, "referrer", { configurable: true, value: "https://mail.example/inbox?email=a%40b.ru&rt=token" });
    window.history.replaceState(null, "", "/courses/one?utm_source=vk&rt=secret");
    document.cookie = "fx_consent=; Max-Age=0; Path=/";
    pathname.current = "/courses/one";
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    delete (window as unknown as { ym?: unknown }).ym;
    document.getElementById("flexperiment-metrika")?.remove();
  });

  it("loads nothing before consent, then sends sanitized location and referrer", async () => {
    const { default: AnalyticsConsentManager, AnalyticsSettingsButton } = await import("../components/analytics/AnalyticsConsent");
    const view = render(<><AnalyticsSettingsButton /><AnalyticsConsentManager /></>);
    expect(document.getElementById("flexperiment-metrika")).toBeNull();
    expect(commands()).toEqual([]);

    act(() => { screen.getByText("Настройки cookies").click(); });
    expect(screen.getByRole("link", { name: "Подробнее в политике конфиденциальности" }))
      .toHaveAttribute("href", "/legal/privacy");
    act(() => { screen.getByText("Разрешить аналитику").click(); });
    expect(document.getElementById("flexperiment-metrika")).toHaveAttribute("src", "https://mc.yandex.ru/metrika/tag.js");
    const init = commands().find((command) => command[1] === "init")!;
    expect(init[2]).toEqual({ clickmap: false, trackLinks: false, accurateTrackBounce: true, defer: true });
    expect(JSON.stringify(init)).not.toContain("webvisor");
    expect(commands().filter((command) => command[1] === "hit")).toEqual([
      [12345, "hit", "/courses/one?utm_source=vk", { title: document.title, referer: "https://mail.example/inbox" }],
    ]);

    pathname.current = "/courses/two";
    view.rerender(<><AnalyticsSettingsButton /><AnalyticsConsentManager /></>);
    expect(commands().filter((command) => command[1] === "hit").at(-1)).toEqual(
      [12345, "hit", "/courses/two?utm_source=vk", { title: document.title, referer: `${window.location.origin}/courses/one` }],
    );
    expect(JSON.stringify(commands())).not.toMatch(/rt=|email|token/);
  });
  it("reads the current privacy date each time the dialog is opened", async () => {
    const { default: AnalyticsConsentManager, AnalyticsSettingsButton } = await import("../components/analytics/AnalyticsConsent");
    const effectiveAt = "2026-11-23T21:00:00.000Z";
    const fetcher = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ effectiveAt }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    try {
      render(<><AnalyticsSettingsButton /><AnalyticsConsentManager /></>);
      expect(fetcher).not.toHaveBeenCalled();
      const settings = screen.getByRole("button", { name: "Настройки cookies" });
      act(() => settings.click());
      expect(await screen.findByText("24 ноября 2026 г.")).toHaveAttribute("datetime", effectiveAt);
      act(() => screen.getByRole("button", { name: "Закрыть" }).click());
      await act(async () => settings.click());
      expect(screen.getByRole("link", { name: "Подробнее в политике конфиденциальности" })).toBeVisible();
      expect(screen.queryByText("24 ноября 2026 г.")).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher).toHaveBeenCalledWith("/legal/privacy/effective-at", expect.objectContaining({
        cache: "no-store", credentials: "omit",
      }));
    } finally { fetcher.mockRestore(); }
  });
});
