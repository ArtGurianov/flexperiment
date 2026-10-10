import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { ownerRpc } from "../../scripts/v2/owner-transport.mjs";

const secret = "synthetic-secret-url-token-jwt";
const message = { operation: "runtime", target: "canary", body: { value: secret } };
const options = { timeout: 90000, maxBuffer: 2000000 };

describe("ART-179 / ART-166 bounded owner STOP diagnostics", () => {
  it.each([
    [{ status: 255 }, "SSH_FAILED"],
    [{ code: "ETIMEDOUT" }, "SSH_TIMEOUT"],
    [{ status: 1, stdout: '{"error":"V2_OWNER_OPERATION_REFUSED","reason":"SUBPROCESS_FAILED"}' }, "SUBPROCESS_FAILED"],
    [{ status: 1, stdout: '{"error":"V2_OWNER_OPERATION_REFUSED","reason":"HTTP_FAILURE","status":503}' }, "HTTP_FAILURE"],
    [{ status: 1, stdout: '{"error":"V2_OWNER_OPERATION_REFUSED"}' }, "TRANSPORT_OR_OPERATION_UNKNOWN"],
    [{ status: 1, stdout: secret }, "TRANSPORT_OR_OPERATION_UNKNOWN"],
    [{ status: 1, stdout: JSON.stringify({ error: "V2_OWNER_OPERATION_REFUSED", reason: secret }) }, "TRANSPORT_OR_OPERATION_UNKNOWN"],
  ])("preserves STOP without retry and reports only bounded context: %s", (error, reason) => {
    const execute = vi.fn(() => { throw Object.assign(new Error(secret), error, { stderr: secret, cmd: secret }); });
    const report = vi.fn();
    expect(() => ownerRpc(message, [secret], options, execute, report)).toThrow("V2_OWNER_TRANSPORT_OR_OPERATION_FAILED");
    expect(execute).toHaveBeenCalledOnce(); expect(report).toHaveBeenCalledOnce();
    const diagnostic = JSON.parse(report.mock.calls[0][0]);
    expect(diagnostic).toMatchObject({ event: "V2_OWNER_RPC_STOP", operation: "runtime", target: "canary", reason });
    expect(JSON.stringify(report.mock.calls)).not.toContain(secret);
    expect(Object.keys(diagnostic).every(key => ["event", "operation", "target", "reason", "status"].includes(key))).toBe(true);
  });
  it.each(["malformed", "null", '"string"', '{"error":"foreign-secret"}'])("stops malformed successful transport: %s", output => {
    const report = vi.fn(), execute = vi.fn(() => output);
    expect(() => ownerRpc(message, [], options, execute, report)).toThrow("V2_OWNER_TRANSPORT_OR_OPERATION_FAILED");
    expect(JSON.parse(report.mock.calls[0][0]).reason).toBe("INVALID_RESPONSE");
    expect(execute).toHaveBeenCalledOnce();
  });
  it("never leaks arbitrary context, status or provider body", () => {
    const report = vi.fn();
    const execute = () => { throw { stdout: JSON.stringify({ error: "V2_OWNER_OPERATION_REFUSED", reason: "HTTP_FAILURE", status: secret, body: secret }) }; };
    expect(() => ownerRpc({ operation: secret, target: secret }, [], options, execute, report)).toThrow();
    expect(JSON.parse(report.mock.calls[0][0])).toEqual({ event: "V2_OWNER_RPC_STOP", operation: "unknown", target: "none", reason: "HTTP_FAILURE" });
  });
  it("returns successful evidence unchanged and preserves transport options", () => {
    const execute = vi.fn<(file: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding) => string>(() => '{"pending":true}'), report = vi.fn();
    expect(ownerRpc(message, ["-o", "StrictHostKeyChecking=yes"], options, execute, report)).toEqual({ pending: true });
    expect(execute.mock.calls[0][2]).toMatchObject({ ...options, input: JSON.stringify(message), stdio: ["pipe", "pipe", "ignore"] });
    expect(report).not.toHaveBeenCalled();
  });
  it("preserves optional first-boot absence without allowing required runtime absence", () => {
    const execute = vi.fn(() => "null"), report = vi.fn();
    expect(ownerRpc({ ...message, optional: true }, [], options, execute, report)).toBeNull();
    expect(report).not.toHaveBeenCalled();
    expect(() => ownerRpc(message, [], options, execute, report)).toThrow("V2_OWNER_TRANSPORT_OR_OPERATION_FAILED");
    expect(JSON.parse(report.mock.calls[0][0]).reason).toBe("INVALID_RESPONSE");
  });
  it("canonical CLI uses the tested boundary rather than discarding errors again", () => {
    const cli = readFileSync("scripts/v2/deploy-cli.mjs", "utf8");
    expect(cli).toContain('import { ownerRpc } from "./owner-transport.mjs"');
    expect(cli).toContain("return ownerRpc(message,");
    expect(cli).not.toContain('catch { throw new Error("V2_OWNER_TRANSPORT_OR_OPERATION_FAILED")');
  });
});
