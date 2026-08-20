import { serve } from "@hono/node-server";
import { createApp } from "./api";
import { migrate, openDatabase } from "./db";
import { providerFromEnvironment } from "./provider";
import { emailProviderFromEnvironment } from "./email-provider";

const sqlite = openDatabase();
migrate(sqlite);
const app = createApp(sqlite, providerFromEnvironment(), emailProviderFromEnvironment());
const port = Number(process.env.PORT ?? 3001);

serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "127.0.0.1" }, (info) => {
  console.log(`Commerce runtime listening on ${info.port}`);
});
