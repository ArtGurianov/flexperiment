// FLEX-122 local smoke: scripted Commerce for apps/my (fixtures only, no provider, no money).
import http from "node:http";
import { readFileSync } from "node:fs";

const fixtures = JSON.parse(readFileSync(process.argv[2], "utf8"));
const MY = process.env.MY_ORIGIN;
let signedIn = process.env.SIGNED_IN === "1";
const statusReads = {};
const log = [];
const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : undefined;
    log.push({ method: req.method, url: req.url, key: req.headers["idempotency-key"], body, host: req.headers["x-forwarded-host"] });
    if (req.url === "/__log") return send(res, 200, log);
    if (req.url === "/__signin") { signedIn = true; return send(res, 200, {}); }
    if (!signedIn) return send(res, 401, { code: "SIGN_IN_REQUIRED" });
    if (req.method === "POST" && req.url === "/v1/checkout/preview") {
      if (body.offerRef === "lab:closed") return send(res, 409, { code: "SALES_STOPPED" });
      const f = body.offerRef.startsWith("lab:") ? fixtures.lab : fixtures.lms;
      return send(res, 200, f.preview);
    }
    if (req.method === "POST" && req.url === "/v1/checkout") {
      const lab = Boolean(body.labAcceptance);
      const order = lab ? "ord-lab-0001" : "ord-course-0001";
      // The fake "provider" returns straight to my: same-origin return URL with ?order=.
      return send(res, 201, { orderPublicId: order, contour: "NATIVE", payment: "AWAITING_PAYMENT", paymentUrl: `${MY}${body.returnPath}?order=${order}` });
    }
    const m = req.method === "GET" && req.url.match(/^\/v1\/checkout\/([\w-]+)$/);
    if (m) {
      const order = m[1];
      if (!order.startsWith("ord-course-0001") && !order.startsWith("ord-lab-0001")) return send(res, 404, { code: "ORDER_NOT_FOUND" });
      statusReads[order] = (statusReads[order] ?? 0) + 1;
      const done = order.startsWith("ord-lab") ? "TICKET_ISSUED" : "ACCESS_GRANTED";
      return send(res, 200, { orderPublicId: order, contour: "NATIVE", payment: statusReads[order] < 2 ? "CONFIRMING" : done });
    }
    send(res, 404, { code: "NOT_FOUND" });
  });
}).listen(4999, "127.0.0.1");
