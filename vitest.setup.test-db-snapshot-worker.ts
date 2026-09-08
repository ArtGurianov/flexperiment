import { inject } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    commerceTestDbSnapshotPath: string | undefined;
  }
}

const snapshotPath = inject("commerceTestDbSnapshotPath");
if (snapshotPath) process.env.COMMERCE_TEST_DB_SNAPSHOT_PATH = snapshotPath;
