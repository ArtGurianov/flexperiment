import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { ErasureLedgerError } from "./erasure-ledger";

// Never selected from env, the merchant database, a backup or the image itself.
export const ERASURE_INSTALLATION_DIRECTORY = "/etc/flexperiment-erasure";
const admitted = new WeakSet<ErasureInstallationEvidence>();
const authority = Object.freeze({});
const base = { version: z.literal(1), installationId: z.string().uuid(), scope: z.enum(["canary", "production"]) };
const policySchema = z.discriminatedUnion("state", [
  z.object({ ...base, state: z.literal("NEVER_INSTALLED") }).strict(),
  z.object({ ...base, state: z.literal("REQUIRED"), fenceDirectory: z.string().max(1024).refine(isAbsolute),
    readerBindingSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
]);
type Policy = z.infer<typeof policySchema>;
function refuse(code: string): never { throw new ErasureLedgerError(code); }
const unescapeMount = (value: string) => value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));

/** Process-private evidence from protected host custody, not caller-supplied JSON.
 * NEVER_INSTALLED is explicit owner admission of a closed legacy environment;
 * missing evidence does NOT mean never installed. There is no runtime writer. */
export class ErasureInstallationEvidence {
  private constructor(readonly policy: Readonly<Policy>, token: object) {
    if (token !== authority) refuse("ERASURE_INSTALLATION_UNVERIFIED");
    Object.freeze(policy); admitted.add(this); Object.freeze(this);
  }
  static assert(evidence: ErasureInstallationEvidence, environment: Readonly<Record<string, string | undefined>>) {
    if (!admitted.has(evidence)) refuse("ERASURE_INSTALLATION_UNVERIFIED");
    const expected = evidence.policy.scope === "canary" ? "staging" : "production";
    if (environment.DEPLOY_ENV !== expected) refuse("ERASURE_INSTALLATION_SCOPE_MISMATCH");
  }
  static assertRuntime(evidence: ErasureInstallationEvidence, environment: Readonly<Record<string, string | undefined>>) {
    ErasureInstallationEvidence.assert(evidence, environment);
    const enabled = environment.ERASURE_FENCING_ENABLED;
    if (enabled === undefined || enabled === "false") {
      if (evidence.policy.state === "REQUIRED") refuse("ERASURE_INSTALLATION_DOWNGRADE_REFUSED");
      return false;
    }
    if (enabled !== "true") refuse("ERASURE_RUNTIME_CONFIGURATION_INVALID");
    if (evidence.policy.state !== "REQUIRED") refuse("ERASURE_INSTALLATION_NOT_ADMITTED");
    if (environment.ERASURE_SCOPE !== evidence.policy.scope || environment.ERASURE_FENCE_DIRECTORY !== evidence.policy.fenceDirectory) {
      refuse("ERASURE_INSTALLATION_BINDING_MISMATCH");
    }
    return true;
  }
  static assertReaderBinding(evidence: ErasureInstallationEvidence, digest: string) {
    if (!admitted.has(evidence) || evidence.policy.state !== "REQUIRED"
      || evidence.policy.readerBindingSha256 !== digest) refuse("ERASURE_INSTALLATION_READ_BINDING_MISMATCH");
  }
  static read(environment: Readonly<Record<string, string | undefined>>, options?: {
    // Trusted filesystem adapter seam for isolated tests only. Actual entrypoints
    // use the fixed directory, UID 0 and the kernel's mount table, never env options.
    directory: string; ownerUid: number; mountInfo: string;
  }) {
    try {
      const directory = options?.directory ?? ERASURE_INSTALLATION_DIRECTORY;
      const ownerUid = options?.ownerUid ?? 0;
      const mounts = options?.mountInfo ?? readFileSync("/proc/self/mountinfo", "utf8");
      const stat = lstatSync(directory);
      if (!isAbsolute(directory) || !stat.isDirectory() || stat.isSymbolicLink()
        || stat.uid !== ownerUid || (stat.mode & 0o777) !== 0o555) refuse("ERASURE_INSTALLATION_EVIDENCE_INVALID");
      // Require an independent read-only host mount, not a baked legacy default.
      const matchingMounts = mounts.split("\n").map(line => {
        const fields = line.split(" - ")[0].split(" ");
        return fields;
      }).filter(fields => fields.length >= 6 && unescapeMount(fields[4]) === directory);
      if (matchingMounts.length !== 1 || !matchingMounts[0][5].split(",").includes("ro")) refuse("ERASURE_INSTALLATION_EVIDENCE_INVALID");
      const file = join(directory, "installation.json");
      const record = lstatSync(file);
      if (!record.isFile() || record.isSymbolicLink() || record.nlink !== 1 || record.uid !== ownerUid
        || (record.mode & 0o777) !== 0o444 || record.size < 1 || record.size > 4096) refuse("ERASURE_INSTALLATION_EVIDENCE_INVALID");
      const evidence = new ErasureInstallationEvidence(policySchema.parse(JSON.parse(readFileSync(file, "utf8"))), authority);
      ErasureInstallationEvidence.assert(evidence, environment);
      return evidence;
    } catch (error) {
      if (error instanceof ErasureLedgerError) throw error;
      return refuse("ERASURE_INSTALLATION_EVIDENCE_INVALID");
    }
  }
}

export function readErasureInstallation(environment = process.env) { return ErasureInstallationEvidence.read(environment); }

/** Foundation cannot be used to evade an installed erasure admission. */
export function assertFoundationErasureAdmission(environment: Readonly<Record<string, string | undefined>>, installed?: ErasureInstallationEvidence) {
  const evidence = installed ?? readErasureInstallation(environment);
  ErasureInstallationEvidence.assert(evidence, environment);
  if (evidence.policy.state !== "NEVER_INSTALLED" || environment.ERASURE_FENCING_ENABLED === "true") {
    refuse("ERASURE_INSTALLED_FOUNDATION_START_FORBIDDEN");
  }
  if (environment.ERASURE_FENCING_ENABLED !== undefined && environment.ERASURE_FENCING_ENABLED !== "false") {
    refuse("ERASURE_RUNTIME_CONFIGURATION_INVALID");
  }
}
