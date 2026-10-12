import { createHash } from "node:crypto";
import { Readable } from "node:stream";

export type ErasureWireRequest = { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body?: unknown };
/** Synthetic object store behind REAL SDK signing/serialization. NOT Cloud.ru qualification. */
export function erasureS3Fixture() {
  const objects = new Map<string, Buffer>(); const versions = new Map<string, Buffer>();
  const requests: ErasureWireRequest[] = [];
  const prefix = "/erasure-canary/flexperiment/erasure/canary/";
  const state = { enabled: true, unavailable: false, loseAck: "", failBefore: "", deleteMarker: false };
  const etag = (b: Buffer) => `"${createHash("sha256").update(b).digest("hex")}"`;
  const response = (statusCode: number, bytes: Buffer, headers: Record<string, string> = {}) => ({response: {
    statusCode, headers: {"content-length": String(bytes.length), ...headers}, body: Readable.from([bytes]),
  }});
  const error = (status: number, code: string) => response(status, Buffer.from(`<Error><Code>${code}</Code><Message>REFLECTED_SECRET</Message></Error>`));
  const handler = { handle: async (r: ErasureWireRequest) => {
    requests.push(r);
    if (state.unavailable) return error(503, "ServiceUnavailable");
    if (r.method === "GET" && Object.hasOwn(r.query, "versioning")) return response(200,
      Buffer.from(`<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${state.enabled ? "Enabled" : "Suspended"}</Status></VersioningConfiguration>`));
    if (r.method === "GET" && Object.hasOwn(r.query, "versions")) return response(200, Buffer.from(
      `<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated>${[...versions.keys()].map(id =>
        `<Version><Key>flexperiment/erasure/canary/head.json</Key><VersionId>${id}</VersionId><IsLatest>false</IsLatest></Version>`).join("")}${state.deleteMarker ?
        "<DeleteMarker><Key>flexperiment/erasure/canary/head.json</Key><VersionId>deleted</VersionId></DeleteMarker>" : ""}</ListVersionsResult>`));
    if (!r.path.startsWith(prefix)) return error(403, "AccessDenied");
    const name = r.path.slice(prefix.length);
    if (r.method === "GET") {
      const b = r.query.versionId ? versions.get(r.query.versionId) : objects.get(name);
      return b ? response(200, b, {etag: etag(b)}) : error(404, "NoSuchKey");
    }
    if (r.method !== "PUT") return error(405, "MethodNotAllowed");
    if (name === state.failBefore) return error(503, "ServiceUnavailable");
    const old = objects.get(name);
    if (r.headers["if-none-match"] === "*" && old || r.headers["if-match"] && (!old || r.headers["if-match"] !== etag(old))) return error(412, "PreconditionFailed");
    const b = Buffer.from(r.body as Uint8Array); objects.set(name, b);
    if (name === "head.json") versions.set(`version-${versions.size + 1}`, b);
    if (state.loseAck === name) { state.loseAck = ""; throw new Error("REFLECTED_SECRET_LOST_ACK"); }
    return response(200, Buffer.alloc(0), {etag: etag(b)});
  }};
  return {objects, versions, requests, state, handler, etag};
}
