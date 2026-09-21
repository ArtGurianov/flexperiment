import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { assertAttended, OperatorTerminalError, TerminalOperator, type OperatorScope, type TerminalChannel } from "../../src/certification/operator-terminal";

/**
 * The payment URL is the reason all of this is strict. It authorizes a real
 * payment, and in an SSH-dispatched run stdout is a workflow log.
 */

let directory: string;
let written: string[];
let answers: string[];
let scope: OperatorScope;

const terminal = (): TerminalChannel => ({
  write: (line) => written.push(line),
  readLine: () => answers.shift() ?? "",
  close: () => {},
});

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "certification-operator-"));
  written = [];
  answers = [];
  writeFileSync(join(directory, "checkout.json"), JSON.stringify({ customer_email: "person@example.invalid", quote_id: "stale" }));
  scope = {
    occurrence: { startsAt: "2026-10-01T10:00:00.000Z", endsAt: "2026-10-01T12:00:00.000Z", venueDisclosureText: "Later", venueAnnounceBy: "2026-09-25T00:00:00.000Z" },
    checkoutBodyPath: join(directory, "checkout.json"),
  };
});

describe("handing a payment page to a person", () => {
  it("writes the URL to the terminal channel and returns nothing that holds it", async () => {
    const operator = new TerminalOperator(scope, terminal());
    const result = await operator.openPaymentPage("https://provider.invalid/pay/abc123");

    expect(result).toBeUndefined();
    expect(written.join("\n")).toContain("https://provider.invalid/pay/abc123");
  });

  it("has no path from the payment URL to a stream anyone keeps", () => {
    // Behaviour proves what this module does; this proves what it cannot do.
    // stdout and stderr in an SSH-dispatched run are a workflow log, and a
    // single `console.log` added later would put a live payment authorization
    // in it without any test noticing.
    const source = readFileSync("commerce/src/certification/operator-terminal.ts", "utf8");
    for (const forbidden of ["console.", "process.stdout", "process.stderr", "appendFileSync", "writeFileSync"]) {
      expect(source, `${forbidden} must not appear here`).not.toContain(forbidden);
    }
    // The URL is a parameter and never a return value, so a caller cannot
    // collect it without changing the signature.
    expect(source).toMatch(/openPaymentPage\(paymentUrl: string\): Promise<void>/);
  });

  it("refuses to run unattended, before anything could be armed", () => {
    // An unattended dispatch must cost a refusal while the old lineage is still
    // a legal destination - not a discovery made past the point of no return
    // with the shop shut.
    expect(() => assertAttended({ stdin: { isTTY: false }, stdout: { isTTY: true } }))
      .toThrow("CERTIFICATION_REQUIRES_ATTENDED_TERMINAL");
    expect(() => assertAttended({ stdin: { isTTY: true }, stdout: { isTTY: false } }))
      .toThrow("CERTIFICATION_REQUIRES_ATTENDED_TERMINAL");
    expect(() => assertAttended({ stdin: {}, stdout: {} })).toThrow(OperatorTerminalError);
  });
});

describe("what the operator is asked, and what counts as an answer", () => {
  it("treats anything but an explicit yes as no", async () => {
    // A blank line, a dropped connection or a closed terminal must never read
    // as confirmation that a ticket arrived.
    for (const [answer, expected] of [["yes", true], ["y", true], ["YES", true], ["", false], ["no", false], ["maybe", false], ["\u0000", false]] as const) {
      answers = [answer];
      expect(await new TerminalOperator(scope, terminal()).confirmTicketVerified()).toBe(expected);
    }
  });

  it("asks on the terminal rather than through the process streams", async () => {
    answers = ["yes"];
    await new TerminalOperator(scope, terminal()).confirmTicketVerified();
    expect(written.join(" ")).toMatch(/ticket email/i);
  });
});

describe("the checkout body the operator prepared", () => {
  it("is read fresh, digested, and never kept by this system", async () => {
    const operator = new TerminalOperator(scope, terminal());
    const request = await operator.checkoutRequest("quote-from-server");

    // The run records the digest, not the body: that is what lets a replay
    // prove the data is identical without this system holding a copy of a real
    // person's details.
    expect(request.sha256).toBe(createHash("sha256").update(request.body).digest("hex"));
    expect(JSON.parse(request.body)).toMatchObject({ customer_email: "person@example.invalid" });
  });

  it("uses the server's quote, never the one written in the file", async () => {
    // A body naming a different quote would buy something other than what is
    // being certified.
    const request = await new TerminalOperator(scope, terminal()).checkoutRequest("quote-from-server");
    expect(JSON.parse(request.body)).toMatchObject({ quote_id: "quote-from-server" });
  });

  it("is stable across attempts, so a replay proves the same request", async () => {
    const operator = new TerminalOperator(scope, terminal());
    const first = await operator.checkoutRequest("quote");
    const second = await operator.checkoutRequest("quote");
    expect(second.sha256).toBe(first.sha256);
  });

  it("refuses a body it cannot read rather than sending an improvised one", async () => {
    const operator = new TerminalOperator({ ...scope, checkoutBodyPath: join(directory, "absent.json") }, terminal());
    await expect(operator.checkoutRequest("quote")).rejects.toThrow("CERTIFICATION_CHECKOUT_BODY_UNREADABLE");
  });
});
