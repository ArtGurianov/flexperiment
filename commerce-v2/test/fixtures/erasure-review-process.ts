import { Readable } from "node:stream";
import { ErasureInstallationEvidence } from "../../src/erasure-installation";
import { runErasureOwnerOperation, type ErasureOwnerConfiguration } from "../../src/erasure-owner";
import type { ReviewedExecutionBoundary } from "../../src/erasure-reviewed-owner";
import type { ErasureWireRequest } from "./erasure-s3";

type Start = {
  config: ErasureOwnerConfiguration;
  operation: unknown;
  boundary: ReviewedExecutionBoundary;
  installationOptions: NonNullable<Parameters<typeof ErasureInstallationEvidence.read>[1]>;
};
type Reply = { id: number; statusCode: number; headers: Record<string, string>; body: Buffer } | { id: number; failed: true };

// Only this child is killed. The parent owns the synthetic custody service, so
// S3 state and request counts survive the end of the CLI process.
process.once("message", async (message: Start) => {
  const { config, operation, boundary, installationOptions } = message;
  const installation = ErasureInstallationEvidence.read({ DEPLOY_ENV: "staging" }, installationOptions);
  let requestId = 0;
  const pending = new Map<number, (reply: Reply) => void>();
  process.on("message", (reply: Reply) => {
    pending.get(reply.id)?.(reply);
    pending.delete(reply.id);
  });
  const requestHandler = {
    handle: (request: ErasureWireRequest) => new Promise<{ response: { statusCode: number; headers: Record<string, string>; body: Readable } }>((resolve, reject) => {
      const id = ++requestId;
      pending.set(id, reply => {
        if ("failed" in reply) reject(new Error("SYNTHETIC_CUSTODY_FAILURE"));
        else resolve({ response: { statusCode: reply.statusCode, headers: reply.headers, body: Readable.from([reply.body]) } });
      });
      const { method, path, query, headers, body } = request;
      process.send!({ id, request: { method, path, query, headers, body } });
    }),
  };
  try {
    await runErasureOwnerOperation(config, operation, { installation, requestHandler,
      reviewedBoundary: point => { if (point === boundary) process.kill(process.pid, "SIGKILL"); } });
    process.exit(2); // The selected boundary was never reached.
  } catch {
    process.exit(1);
  }
});
