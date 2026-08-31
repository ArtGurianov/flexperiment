import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `curl --fail-with-body` writes the body to the output file and reports only
 * `curl: (22)`. During the 0039 cutover the server twice refused with a precise
 * reason and the operator saw exit code 22 both times: the enforcement point had
 * already answered, and the transport client discarded the answer.
 *
 * Same shape as the other three defects this programme found - the authority was
 * right, the seam that carried its answer was not.
 */

const WORKFLOWS = ".github/workflows";
const controllers = readdirSync(WORKFLOWS)
  .filter((name) => name.startsWith("controlled-") && name.endsWith(".yml"))
  .map((name) => ({ name, source: readFileSync(`${WORKFLOWS}/${name}`, "utf8") }));

const run = (script: string) => {
  try {
    return { ok: true, out: execFileSync("bash", ["-c", script], { encoding: "utf8", stdio: "pipe" }) };
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string };
    return { ok: false, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
};

describe("release API error surfacing", () => {
  it("is used by every controller that talks to release-control", () => {
    const authed = controllers.filter(({ source }) => source.includes("COMMERCE_RELEASE_CONTROL_TOKEN"));
    expect(authed.length).toBeGreaterThan(0);
    for (const { name, source } of authed) {
      expect(source, `${name} does not source the shared client`).toContain("scripts/release/release-api.sh");
    }
  });

  it("leaves no controller defining its own fail-with-body helper", () => {
    for (const { name, source } of controllers) {
      expect(source, `${name} still inlines a helper that discards the response body`)
        .not.toMatch(/api\(\) \{ curl --fail-with-body/);
    }
  });

  it("prints the status, error code and body when the server refuses", () => {
    // A real refusal shape, served locally: the operator must see what the
    // enforcement point said, not the client's exit code.
    const result = run(`
      set -uo pipefail
      export COMMERCE_RELEASE_CONTROL_TOKEN=t
      node -e '
        const net = require("node:net");
        const body = JSON.stringify({ error: { code: "CERTIFICATION_CLEANUP_INCOMPLETE" } });
        const server = net.createServer((socket) => {
          socket.once("data", () => {
            socket.end("HTTP/1.1 409 Conflict\\r\\nContent-Type: application/json\\r\\nContent-Length: " + Buffer.byteLength(body) + "\\r\\nConnection: close\\r\\n\\r\\n" + body);
            server.close();
          });
        });
        server.listen(8731, "127.0.0.1");
      ' &
      sleep 0.4
      source scripts/release/release-api.sh
      api http://127.0.0.1:8731/ > /dev/null
    `);
    expect(result.ok).toBe(false);
    expect(result.out).toContain("RELEASE_API_REFUSED");
    expect(result.out).toContain("HTTP 409");
    expect(result.out).toContain("CERTIFICATION_CLEANUP_INCOMPLETE");
  });

  it("distinguishes a transport failure from a server refusal", () => {
    const result = run(`
      set -uo pipefail
      export COMMERCE_RELEASE_CONTROL_TOKEN=t
      source scripts/release/release-api.sh
      api --connect-timeout 1 http://127.0.0.1:9/ > /dev/null
    `);
    expect(result.ok).toBe(false);
    expect(result.out).toContain("RELEASE_API_TRANSPORT_FAILURE");
    expect(result.out).not.toContain("RELEASE_API_REFUSED");
  });
});
