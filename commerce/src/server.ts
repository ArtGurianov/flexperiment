import { serve } from "@hono/node-server";
import { createApp } from "./api";
import { migrate, openDatabase } from "./db";
import { providerFromEnvironment } from "./provider";
import { emailProviderFromEnvironment } from "./email-provider";
import { smartCaptchaVerifierFromEnvironment } from "./smartcaptcha";
import { writeRuntimeReleaseEvidence } from "./runtime-release-evidence";

const sqlite = openDatabase();
migrate(sqlite);
const provider = providerFromEnvironment();
const emailProvider = emailProviderFromEnvironment();
const smartCaptchaVerifier = smartCaptchaVerifierFromEnvironment();
writeRuntimeReleaseEvidence(sqlite, "COMMERCE", process.env.SOURCE_COMMIT?.trim() || "UNAVAILABLE", true);
const app = createApp(sqlite, provider, emailProvider, smartCaptchaVerifier);
const port = Number(process.env.PORT ?? 3001);

serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "127.0.0.1" }, (info) => {
  console.log(`Commerce runtime listening on ${info.port}`);
});
