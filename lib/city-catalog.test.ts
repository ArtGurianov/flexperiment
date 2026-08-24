import { describe, expect, it } from "vitest";
import { CITY_CATALOGUE, findCityBySlug, getCityBySlug, isCitySlug, requestableCities } from "./city-catalog";

describe("city-interest catalogue", () => {
  it("excludes scheduled cities without hiding supported unplanned cities", () => {
    const cities = requestableCities(["novosibirsk", "kemerovo"]);
    expect(cities.map(({ slug }) => slug)).not.toContain("novosibirsk");
    expect(cities.map(({ slug }) => slug)).not.toContain("kemerovo");
    expect(cities).toContainEqual({ slug: "moscow", title: "Москва", timezone: "Europe/Moscow" });
    expect(cities).toContainEqual({ slug: "abakan", title: "Абакан", timezone: "Asia/Krasnoyarsk" });
  });

  it("has one distinct entry per requestable city", () => {
    const slugs = CITY_CATALOGUE.map(({ slug }) => slug);
    const titles = CITY_CATALOGUE.map(({ title }) => title);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(titles).size).toBe(titles.length);
    expect(isCitySlug("omsk")).toBe(true);
    expect(isCitySlug("unknown-city")).toBe(false);
    expect(findCityBySlug("omsk")).toEqual({ slug: "omsk", title: "Омск", timezone: "Asia/Omsk" });
    expect(getCityBySlug("tomsk")).toEqual({ slug: "tomsk", title: "Томск", timezone: "Asia/Tomsk" });
  });

  it("assigns every requestable city a supported IANA timezone", () => {
    const supported = new Set(Intl.supportedValuesOf("timeZone"));
    for (const city of CITY_CATALOGUE) expect(supported).toContain(city.timezone);
  });
});
