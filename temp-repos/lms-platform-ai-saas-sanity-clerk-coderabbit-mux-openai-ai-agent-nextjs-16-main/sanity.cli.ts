/**
 * This configuration file lets you run `$ sanity [command]` in this folder
 * Go to https://www.sanity.io/docs/cli to learn more.
 **/
import { defineCliConfig } from "sanity/cli";
import { loadEnvConfig } from "@next/env";

// Load .env.local for Sanity CLI
loadEnvConfig(process.cwd());

const projectId = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID;
const dataset = process.env.NEXT_PUBLIC_SANITY_DATASET;
const organizationId = process.env.NEXT_PUBLIC_SANITY_ORG_ID;

if (!projectId || !dataset || !organizationId) {
  throw new Error("Missing environment variables");
}

export default defineCliConfig({
  api: { projectId, dataset },

  app: {
    organizationId: organizationId,
    entry: "./app",
  },
});
