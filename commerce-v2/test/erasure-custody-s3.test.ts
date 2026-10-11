import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createErasureS3Custody } from "../src/erasure-custody-s3";
import { CUSTODY_MAX_BYTES } from "../src/erasure-custody";

type WireRequest = {method: string; path: string; headers: Record<string,string>; body?: unknown};
const clients: ReturnType<typeof createErasureS3Custody>[] = [];
afterEach(() => { clients.splice(0).forEach(client => client.close()); });
function fixture(input: {status?: number; body?: Buffer; headers?: Record<string,string>; throws?: boolean} = {}) {
  const requests: WireRequest[] = [];
  const client = createErasureS3Custody({endpoint: "https://custody.example.test", region: "region-1", bucket: "independent-custody",
    prefix: "flexperiment/erasure/canary/", scope: "canary", accessKeyId: "TEST_ACCESS_ID", secretAccessKey: "TEST_SECRET",
    requestHandler: {handle: async (request: WireRequest) => {
      requests.push(request);
      if (input.throws) throw new Error("REFLECTED_SECRET_URL");
      return {response: {statusCode: input.status ?? 200, headers: input.headers ?? {etag: '"remote-etag"'},
        body: Readable.from([input.body ?? Buffer.from("{}")])}};
    }} });
  clients.push(client); return {client,requests};
}
describe("S3 owner custody adapter using real SDK serialization/signing, no cloud writes", () => {
  it("signs exact scoped conditional writes and GET; does not replace CAS with unconditional PUT", async () => {
    const {client, requests} = fixture();
    const bundleKey = `bundles/0-${"a".repeat(64)}.json`;
    await client.create(bundleKey,Buffer.from("{}"));
    await client.compareExchange("head.json",Buffer.from("{}"),'"old-etag"');
    expect(await client.read("head.json")).toEqual({bytes: Buffer.from("{}"),etag: '"remote-etag"'});
    expect(requests.map(r=>r.method)).toEqual(["PUT","PUT","GET"]);
    expect(requests[0].headers["if-none-match"]).toBe("*");
    expect(requests[1].headers["if-match"]).toBe('"old-etag"');
    for (const request of requests) {
      expect(request.path).toContain("/independent-custody/flexperiment/erasure/canary/");
      expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256/);
      expect(request.headers.authorization).not.toContain("TEST_SECRET");
    }
    expect(requests[1].headers.authorization).toContain("if-match");
    expect(requests[0].headers.authorization).toContain("if-none-match");
  });
  it.each([409,412,500,503])("stops at one write on HTTP %s, excluding reflected bodies", async status => {
    const {client,requests} = fixture({status, body: Buffer.from("<Error><Code>Failure</Code><Message>REFLECTED_SECRET_URL</Message></Error>")});
    await expect(client.compareExchange("head.json",Buffer.from("{}"),'"etag"')).rejects.toThrow("ERASURE_REMOTE_OPERATION_UNCONFIRMED");
    expect(requests).toHaveLength(1);
  });
  it("stops after a lost write response, never retries", async () => {
    const {client,requests} = fixture({throws:true});
    await expect(client.create("head.json",Buffer.from("{}"))).rejects.toThrow("ERASURE_REMOTE_OPERATION_UNCONFIRMED");
    expect(requests).toHaveLength(1);
  });
  it("distinguishes NoSuchKey from denied/missing bucket; no empty-ledger fallback", async () => {
    const absent=fixture({status:404,body: Buffer.from("<Error><Code>NoSuchKey</Code></Error>")});
    expect(await absent.client.read("head.json")).toBeNull();
    for(const code of ["NoSuchBucket","AccessDenied"]) {
      const other=fixture({status:404,body:Buffer.from(`<Error><Code>${code}</Code><Message>SECRET</Message></Error>`)});
      await expect(other.client.read("head.json")).rejects.toThrow("ERASURE_REMOTE_OPERATION_UNCONFIRMED");
      expect(other.requests).toHaveLength(1);
    }
  });
  it.each(["oversized-header","oversized-stream","truncated","missing-etag","bad-etag"])("rejects %s", async mode => {
    const {client}=fixture({headers: {etag: mode==="missing-etag"?"":mode==="bad-etag"?'"reflected\nSECRET"':'"etag"',
      ...(mode==="oversized-header"?{"content-length":String(CUSTODY_MAX_BYTES+1)}: mode==="truncated"?{"content-length":"100"}:{})},
      body:mode==="oversized-stream"?Buffer.alloc(CUSTODY_MAX_BYTES+1):Buffer.from("{}")});
    await expect(client.read("head.json")).rejects.toThrow("ERASURE_REMOTE_OPERATION_UNCONFIRMED");
  });
  it("refuses foreign scopes/paths and malformed conditional ETags before making a request", async () => {
    const {client,requests}=fixture();
    await expect(client.read("../production/head.json")).rejects.toThrow(/ERASURE_/);
    await expect(client.create("head.json",Buffer.alloc(CUSTODY_MAX_BYTES+1))).rejects.toThrow(/ERASURE_/);
    expect(()=>client.compareExchange("head.json",Buffer.from("{}"),'"SECRET\n"')).toThrow(/ERASURE_/);
    expect(()=>client.compareExchange(`bundles/0-${"a".repeat(64)}.json`,Buffer.from("{}"),'"etag"')).toThrow(/ERASURE_/);
    expect(requests).toHaveLength(0);
  });
});
