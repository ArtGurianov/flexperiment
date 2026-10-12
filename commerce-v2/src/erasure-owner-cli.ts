import { readOwnerConfiguration, runErasureOwnerOperation } from "./erasure-owner";
import { ErasureLedgerError } from "./erasure-ledger";

async function main() {
  process.umask(0o077);
  if (process.argv.length !== 4 || process.argv[2] !== "--config") throw new ErasureLedgerError("ERASURE_OWNER_CONFIGURATION_INVALID");
  const configuration = readOwnerConfiguration(process.argv[3]);
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk); length += bytes.length;
    if (length > 64 * 1024) throw new ErasureLedgerError("ERASURE_OWNER_CONFIGURATION_INVALID"); chunks.push(bytes);
  }
  const result = await runErasureOwnerOperation(configuration, JSON.parse(Buffer.concat(chunks).toString("utf8")));
  console.log(JSON.stringify(result));
}
void main().catch(error => {
  console.error(error instanceof ErasureLedgerError && /^ERASURE_[A-Z_]{1,100}$/.test(error.message) ? error.message : "ERASURE_OWNER_OPERATION_REFUSED");
  process.exitCode = 1;
});
