import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";

/** Node fetch derives Host from the URL, even when headers contain another Host.
 * The private canary hop must carry the approved public host to Commerce. */
export async function canaryCommerceRequest(target: URL, options: RequestInit) {
  if (target.protocol !== "http:") throw new Error("CANARY_TRANSPORT_REFUSED");
  return await new Promise<Response>((resolve, reject) => {
    const outgoing = httpRequest(target, {
      method: options.method,
      headers: Object.fromEntries(new Headers(options.headers)),
      signal: options.signal ?? undefined,
    }, (incoming) => {
      try {
        const headers = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
          headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
        }
        const status = incoming.statusCode ?? 502;
        const noBody = options.method === "HEAD" || [204, 205, 304].includes(status);
        if (noBody) incoming.resume();
        resolve(new Response(noBody ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
          status, headers,
        }));
      } catch (error) { incoming.destroy(); reject(error); }
    });
    outgoing.on("error", reject);
    if (options.body) {
      const input = Readable.fromWeb(options.body as import("node:stream/web").ReadableStream);
      input.on("error", (error) => outgoing.destroy(error));
      outgoing.on("close", () => input.destroy());
      input.pipe(outgoing);
    } else outgoing.end();
  });
}
