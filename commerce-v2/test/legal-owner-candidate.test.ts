import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const directory = "docs/legal/stage-a/2026-10-11-candidate";
const manifest = JSON.parse(readFileSync(`${directory}/manifest.json`, "utf8")) as {
  ownerApproval: string; activation: string; rkn: string;
  documents: Array<{ kind: string; approvedSource: { path: string; sha256: string }; candidate: { path: string; sha256: string } }>;
};
describe("owner facts without fabricated legal activation", () => {
  it("records owner approval and owner-confirmed RKN, but not legal activation or registry verification", () => {
    expect(manifest.ownerApproval).toBe("OWNER_APPROVAL_RECEIVED");
    expect(manifest.rkn).toBe("OWNER_CONFIRMED_SUBMITTED");
    expect(manifest.activation).toBe("PROHIBITED_UNTIL_ADMISSION");
    expect(manifest).not.toHaveProperty("stage");
    expect(manifest).not.toHaveProperty("rknNotificationNumber");
  });
  it.each(manifest.documents)("binds exact old/new bytes for $kind without silent rewrite", document => {
    for (const source of [document.approvedSource, document.candidate]) {
      const bytes = readFileSync(source.path);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(source.sha256);
    }
    const candidate = readFileSync(document.candidate.path, "utf8");
    expect(candidate).toContain("2026-10-11.candidate.1");
    expect(candidate).toContain("650023, Россия, г. Кемерово, проспект Московский, д. 17, кв. 360");
    expect(candidate).toContain("art@flexperiment.ru");
    expect(candidate).not.toContain("[ПОДТВЕРДИТЬ АДРЕС]");
  });
});
