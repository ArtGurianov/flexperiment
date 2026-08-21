import { describe, expect, it } from "vitest";
import { occurrenceActionsFor } from "./occurrence-actions";

describe("occurrence action derivation", () => {
  it("removes Close after the authoritative OPEN to CLOSED response", () => {
    expect(occurrenceActionsFor({ visibility: "PUBLISHED", sales_status: "OPEN" }).map((action) => action.label)).toEqual(["Скрыть", "Пауза", "Закрыть"]);
    expect(occurrenceActionsFor({ visibility: "PUBLISHED", sales_status: "CLOSED" }).map((action) => action.label)).toEqual(["Скрыть", "Открыть продажи"]);
  });

  it("recalculates public visibility actions after the authoritative hide response", () => {
    expect(occurrenceActionsFor({ visibility: "PUBLISHED", sales_status: "CLOSED" }).map((action) => action.label)).toContain("Скрыть");
    expect(occurrenceActionsFor({ visibility: "HIDDEN", sales_status: "CLOSED" }).map((action) => action.label)).toEqual(["Опубликовать", "Открыть продажи"]);
  });
});
