import { sqliteAdapter } from "@payloadcms/db-sqlite";
import { lexicalEditor } from "@payloadcms/richtext-lexical";
import { s3Storage } from "@payloadcms/storage-s3";
import { buildConfig } from "payload";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";
import { Courses } from "@/collections/Courses";
import { Lessons } from "@/collections/Lessons";
import { Media } from "@/collections/Media";
import { Sections } from "@/collections/Sections";
import { Users } from "@/collections/Users";
import { AccessOperations } from "@/collections/AccessOperations";
import { reconcileCourseManifestsTask, syncCourseManifestTask } from "@/lib/manifest/tasks";
import { platformSearchPlugin } from "@/lib/search-plugin";
import { assertPayloadTransactions } from "@/lib/payload-transaction-assertion";
import { serializeDatabaseTransactions } from "@/lib/serialized-transactions";

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

const requireEnvironment = (name: string) => {
  const value = process.env[name];
  if (!value && process.env.NODE_ENV === "production") throw new Error(`${name}_REQUIRED`);
  return value;
};

requireEnvironment("SOURCE_COMMIT");

const s3Bucket = process.env.S3_BUCKET;

export default buildConfig({
  onInit: assertPayloadTransactions,
  secret: requireEnvironment("PAYLOAD_SECRET") ?? "development-only-payload-secret-change-me",
  serverURL: process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:3001",
  admin: {
    user: Users.slug,
    importMap: { baseDir: path.resolve(dirname) },
  },
  routes: { admin: "/admin", api: "/api" },
  graphQL: { disable: true },
  editor: lexicalEditor(),
  collections: [Users, Media, Courses, Sections, Lessons, AccessOperations],
  db: serializeDatabaseTransactions(sqliteAdapter({
    client: { url: requireEnvironment("PAYLOAD_DATABASE_URL") ?? "file:./platform-data/payload.sqlite" },
    migrationDir: path.resolve(dirname, "migrations"),
    push: process.env.NODE_ENV !== "production",
    transactionOptions: {},
    wal: true,
    busyTimeout: 5000,
  })),
  jobs: {
    autoRun: [{ cron: "*/5 * * * *", queue: "default", limit: 50 }],
    shouldAutoRun: async () => process.env.PAYLOAD_JOBS_ENABLED !== "false",
    tasks: [syncCourseManifestTask, reconcileCourseManifestsTask],
  },
  plugins: [platformSearchPlugin, ...(s3Bucket ? [s3Storage({
    bucket: s3Bucket,
    collections: { media: true },
    config: {
      endpoint: requireEnvironment("S3_ENDPOINT"),
      region: process.env.S3_REGION ?? "ru-central-1",
      credentials: {
        accessKeyId: requireEnvironment("S3_ACCESS_KEY_ID")!,
        secretAccessKey: requireEnvironment("S3_SECRET_ACCESS_KEY")!,
      },
      forcePathStyle: true,
    },
  })] : [])],
  sharp,
  typescript: { outputFile: path.resolve(dirname, "payload-types.ts") },
});
