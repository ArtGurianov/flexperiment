import { describe, expect, it } from "vitest";
import { presentAdminError } from "./errors";

describe("presentAdminError", () => {
  it("gives the revision conflict an actionable recovery path", () => {
    expect(presentAdminError("OCCURRENCE_REVISION_CONFLICT").hint).toMatch(/перечитаны/i);
  });

  it("keeps unknown backend codes visible", () => {
    expect(presentAdminError("FUTURE_CODE").message).toContain("FUTURE_CODE");
  });

  it("explains that a projected legal identity is not editable on the agent card", () => {
    expect(presentAdminError("AGENT_REFERRALS_CONTRACTOR_TYPE_PROJECTION_LOCKED").message).toMatch(/юридическим профилем партнёра/i);
    expect(presentAdminError("AGENT_REFERRALS_CONTRACTOR_TYPE_PROJECTION_LOCKED").hint).toMatch(/смену юридических данных партнёра/i);
    expect(presentAdminError("AGENT_REFERRALS_LEGAL_IDENTITY_PROJECTION_LOCKED").message).toMatch(/Наименование и ИНН/i);
  });

  it("explains the distinct idempotency recovery paths", () => {
    expect(presentAdminError("IDEMPOTENCY_KEY_INVALID").hint).toMatch(/новым ключом/i);
    expect(presentAdminError("IDEMPOTENCY_CONTRACT_SUPERSEDED").hint).toMatch(/Не создавайте новый ключ/i);
  });
});
