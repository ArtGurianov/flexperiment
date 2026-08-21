import { describe, expect, it } from "vitest";
import { occurrenceActionsFor } from "./occurrence-actions";

describe("occurrence action derivation", () => {
  it("offers only transitions from the four valid catalog states", () => {
    expect(occurrenceActionsFor({ visibility: "HIDDEN", sales_status: "CLOSED" }).map((action) => action.label)).toEqual(["Опубликовать"]);
    expect(occurrenceActionsFor({ visibility: "PUBLISHED", sales_status: "CLOSED" }).map((action) => action.label)).toEqual(["Открыть продажи", "Скрыть"]);
    expect(occurrenceActionsFor({ visibility: "PUBLISHED", sales_status: "OPEN" }).map((action) => action.label)).toEqual(["Пауза", "Закрыть"]);
    expect(occurrenceActionsFor({ visibility: "PUBLISHED", sales_status: "PAUSED" }).map((action) => action.label)).toEqual(["Открыть продажи", "Закрыть"]);
  });

  it("offers only the one-way close-sales recovery for legacy hidden sellable states", () => {
    expect(occurrenceActionsFor({ visibility: "HIDDEN", sales_status: "OPEN" }).map((action) => action.label)).toEqual(["Закрыть продажи"]);
    expect(occurrenceActionsFor({ visibility: "HIDDEN", sales_status: "PAUSED" }).map((action) => action.label)).toEqual(["Закрыть продажи"]);
  });
});
