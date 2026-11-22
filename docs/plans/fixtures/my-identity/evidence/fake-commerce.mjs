import http from "node:http";
const log = [];
const doc = (kind) => ({ kind, version: `${kind}-v1`, sha256: "a".repeat(64), url: `https://flexperiment.ru/legal/${kind}` });
http.createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  log.push({ path: req.url, host: req.headers["x-forwarded-host"], body: body ? JSON.parse(body) : null });
  const json = (status, value, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(value)); };
  if (req.url === "/__log") return json(200, log);
  if (req.url === "/v1/my/consents" && req.method === "GET") return json(200, { actionSequence: 0, requiredChoicesConfirmed: false });
  if (req.url === "/v1/my/consents") return json(200, { recorded: true });
  if (req.url === "/v1/my/legal") return json(200, { version: "v1", manifestSha256: "b".repeat(64), manifest: { documents: ["personal_data", "account_terms", "marketing_consent"].map(doc) } });
  if (req.url === "/v1/my/otp/send") return json(202, { status: "CODE_SENT_IF_ALLOWED", resendAfterSeconds: 60 });
  if (req.url === "/v1/my/otp/verify") {
    const { otp } = JSON.parse(body);
    if (otp !== "123456") return json(400, { code: "OTP_INVALID_OR_EXPIRED" });
    return json(200, { accountCreated: true, next: "/orders" }, { "set-cookie": "__Secure-better-auth.session_token=x; Path=/; HttpOnly; Secure; SameSite=Lax" });
  }
  json(404, { code: "NOT_FOUND" });
}).listen(3998, "127.0.0.1");
