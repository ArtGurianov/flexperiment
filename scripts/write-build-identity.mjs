import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [targetArgument, service] = process.argv.slice(2);
const sourceCommit = process.env.SOURCE_COMMIT?.trim();

if (!targetArgument || !service) throw new Error("usage: write-build-identity.mjs <target> <service>");
if (!/^[0-9a-f]{40}$/.test(sourceCommit ?? "")) throw new Error("SOURCE_COMMIT_INVALID");
if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(service)) throw new Error("BUILD_IDENTITY_SERVICE_INVALID");

const target = resolve(targetArgument);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify({ schema: "flexperiment.build-identity/1", service, sourceCommit })}\n`, {
  encoding: "utf8",
  mode: 0o444,
});
chmodSync(target, 0o444);
