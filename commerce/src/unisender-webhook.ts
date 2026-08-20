import { createHash, timingSafeEqual } from "node:crypto";

export const verifyUnisenderWebhook = (rawBody: string, apiKey: string) => {
  const match = /"auth"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(rawBody);
  if (!match) return false;
  const claimed = match[1];
  const replacement = JSON.stringify(apiKey).slice(1, -1);
  const bodyForDigest = `${rawBody.slice(0, match.index! + match[0].indexOf(claimed))}${replacement}${rawBody.slice(match.index! + match[0].indexOf(claimed) + claimed.length)}`;
  const expected = createHash("md5").update(bodyForDigest).digest("hex");
  const expectedBytes = Buffer.from(expected, "utf8"); const claimedBytes = Buffer.from(claimed, "utf8");
  return expectedBytes.length === claimedBytes.length && timingSafeEqual(expectedBytes, claimedBytes);
};
