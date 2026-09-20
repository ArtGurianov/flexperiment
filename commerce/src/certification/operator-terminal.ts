import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, writeSync } from "node:fs";
import type { OccurrenceDraft } from "./run";
import type { OperatorPort } from "./machine";

/**
 * The human half of certification, at a real terminal.
 *
 * Certification exists to prove a person can buy a ticket and read it, so one
 * step of it is irreducibly attended. Everything here follows from where that
 * person is: at a controlling terminal, in their own session, not in a CI job.
 *
 * The payment URL is the reason for the strictness. It authorizes a real
 * payment, and it must not reach anywhere it would be kept: not stdout or
 * stderr, which in an SSH-dispatched run are a workflow log; not the journal,
 * the session record or the cutover envelope; not a process argument, which
 * every other process on the host can read. `/dev/tty` is the one channel that
 * goes to the person and nowhere else.
 */

export class OperatorTerminalError extends Error {
  constructor(readonly code: string, readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type OperatorScope = {
  /** The occurrence the certification will create, prepared by the operator in advance. */
  readonly occurrence: Omit<OccurrenceDraft, "cityId">;
  /**
   * The checkout body, exactly as it will be sent. It carries a real person's
   * details, so it is read from the operator's own file on every attempt and
   * never copied into anything this system keeps.
   */
  readonly checkoutBodyPath: string;
};

export type TerminalChannel = {
  write(line: string): void;
  readLine(): string;
  close(): void;
};

/**
 * Opens the controlling terminal, or refuses.
 *
 * A redirected stream is not a terminal, and neither is a pipe that happens to
 * be attached. Asking `/dev/tty` directly is the check: a process with no
 * controlling terminal cannot open it at all, which is exactly the answer
 * needed before a payment page is produced.
 */
export const openControllingTerminal = (): TerminalChannel => {
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch {
    throw new OperatorTerminalError("CERTIFICATION_REQUIRES_ATTENDED_TERMINAL",
      "no controlling terminal; run this from an interactive session, never from a workflow");
  }
  return {
    write(line: string) { writeSync(fd, `${line}\n`); },
    readLine(): string {
      const buffer = Buffer.alloc(1);
      let answer = "";
      for (;;) {
        const read = readSync(fd, buffer, 0, 1, null);
        if (read === 0) break;
        const char = buffer.toString("utf8");
        if (char === "\n") break;
        if (char !== "\r") answer += char;
        if (answer.length > 256) break;
      }
      return answer.trim();
    },
    close() { closeSync(fd); },
  };
};

/**
 * Refuses before anything is armed when the session is not attended.
 *
 * Called at the start of the operator phase, so an unattended dispatch costs a
 * refusal while the old lineage is still a legal destination - rather than
 * discovering it after the point of no return, with the shop shut.
 */
export const assertAttended = (streams: { stdin: { isTTY?: boolean }; stdout: { isTTY?: boolean } } = process): void => {
  if (!streams.stdin.isTTY || !streams.stdout.isTTY) {
    throw new OperatorTerminalError("CERTIFICATION_REQUIRES_ATTENDED_TERMINAL",
      "stdin and stdout must both be a terminal; a redirected stream means nobody is watching");
  }
  openControllingTerminal().close();
};

export class TerminalOperator implements OperatorPort {
  constructor(private readonly scope: OperatorScope, private readonly terminal: TerminalChannel) {}

  async occurrenceDraft(cityId: string): Promise<Omit<OccurrenceDraft, "cityId">> {
    void cityId;
    return this.scope.occurrence;
  }

  /**
   * The body and its digest, read fresh each time and never persisted here.
   *
   * The run records only the digest, which is what makes a replay able to prove
   * the re-entered data is identical without this system holding a copy of a
   * real person's details.
   */
  async checkoutRequest(quoteId: string): Promise<{ body: string; sha256: string }> {
    let raw: string;
    try {
      raw = readFileSync(this.scope.checkoutBodyPath, "utf8");
    } catch (error) {
      throw new OperatorTerminalError("CERTIFICATION_CHECKOUT_BODY_UNREADABLE", error instanceof Error ? error.message : "unknown error");
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // The quote is the server's, not the operator's file's: a body naming a
    // different quote would buy something other than what was certified.
    const body = JSON.stringify({ ...parsed, quote_id: quoteId });
    return { body, sha256: createHash("sha256").update(body).digest("hex") };
  }

  /**
   * Hands the person the payment page, on the terminal and nowhere else.
   *
   * Not returned, not logged, not stored. A caller that wanted to keep it would
   * have to change this signature, which is the point.
   */
  async openPaymentPage(paymentUrl: string): Promise<void> {
    this.terminal.write("");
    this.terminal.write("Open this payment page and complete the payment. It is shown here only:");
    this.terminal.write(`  ${paymentUrl}`);
    this.terminal.write("");
  }

  /**
   * Nothing automated substitutes for a person opening the mailbox.
   *
   * Anything but an explicit yes is a no: a blank line, a dropped connection or
   * a closed terminal must never read as confirmation that a ticket arrived.
   */
  async confirmTicketVerified(): Promise<boolean> {
    this.terminal.write("Did the ticket email arrive, and does the ticket open? [yes/no]");
    const answer = this.terminal.readLine().toLowerCase();
    return answer === "yes" || answer === "y";
  }
}
