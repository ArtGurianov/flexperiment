import { readFileSync } from "node:fs";
import { canonicalReleasePacket, validateReleasePacket } from "./release-control-v2";

const path = process.argv[2];
if (!path) throw new Error("Pass the release packet JSON path.");
const packet = validateReleasePacket(JSON.parse(readFileSync(path, "utf8")));
process.stdout.write(`${canonicalReleasePacket(packet)}\n`);
