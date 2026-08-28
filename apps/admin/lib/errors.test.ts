import { describe, expect, it } from "vitest";
import { presentAdminError } from "./errors";

describe("presentAdminError", () => {
  it("gives the revision conflict an actionable recovery path", () => {
    expect(presentAdminError("OCCURRENCE_REVISION_CONFLICT").hint).toMatch(/перечитаны/i);
  });

  it("keeps unknown backend codes visible", () => {
    expect(presentAdminError("FUTURE_CODE").message).toContain("FUTURE_CODE");
  });

  it("explains the distinct idempotency recovery paths", () => {
    expect(presentAdminError("IDEMPOTENCY_KEY_INVALID").hint).toMatch(/новым ключом/i);
    expect(presentAdminError("IDEMPOTENCY_CONTRACT_SUPERSEDED").hint).toMatch(/Не создавайте новый ключ/i);
  });
});
