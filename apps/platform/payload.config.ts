import { sqliteAdapter } from "@payloadcms/db-sqlite";
import { lexicalEditor } from "@payloadcms/richtext-lexical";
import { s3Storage } from "@payloadcms/storage-s3";
import { buildConfig } from "payload";
import { platformOrigin } from "./lib/origins";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";
import { Courses } from "@/collections/Courses";
import { Lessons } from "@/collections/Lessons";
import { Media } from "@/collections/Media";
import { Sections } from "@/collections/Sections";
import { Users } from "@/collections/Users";
import { AccessOperations } from "@/collections/AccessOperations";
import { CourseManifestStates } from "@/collections/CourseManifestStates";
import { reconcileCourseManifestsTask, syncCourseManifestTask } from "@/lib/manifest/tasks";
import { platformSearchPlugin } from "@/lib/search-plugin";
import { assertPayloadTransactions } from "@/lib/payload-transaction-assertion";
import { publicMediaFileURL } from "@/lib/public-media";
import { serializeDatabaseTransactions } from "@/lib/serialized-transactions";
import { validatePlatformCanary } from "@/lib/canary-config";
import { closedEditorial, closedEmail } from "@/lib/canary-editorial";

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

const requireEnvironment = (name: string) => {
  const value = process.env[name];
  if (!value && process.env.NODE_ENV === "production") throw new Error(`${name}_REQUIRED`);
  return value;
};

const requireConfiguredEnvironment = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
};

requireEnvironment("SOURCE_COMMIT");
const canaryPreparation = validatePlatformCanary();

const s3Bucket = process.env.S3_BUCKET;
const s3Config = s3Bucket ? {
  endpoint: requireConfiguredEnvironment("S3_ENDPOINT"),
  region: process.env.S3_REGION ?? "ru-central-1",
  credentials: {
    accessKeyId: requireConfiguredEnvironment("S3_ACCESS_KEY_ID"),
    secretAccessKey: requireConfiguredEnvironment("S3_SECRET_ACCESS_KEY"),
  },
  forcePathStyle: true,
} : {};

export default buildConfig({
  email: canaryPreparation ? closedEmail : undefined,
  onInit: assertPayloadTransactions,
  secret: requireEnvironment("PAYLOAD_SECRET") ?? "development-only-payload-secret-change-me",
  serverURL: platformOrigin(),
  admin: {
    user: Users.slug,
    importMap: { baseDir: path.resolve(dirname) },
  },
  routes: { admin: "/admin", api: "/api" },
  graphQL: { disable: true },
  editor: lexicalEditor(),
  collections: [Users, Media, Courses, Sections, Lessons, AccessOperations, CourseManifestStates].map((collection) =>
    canaryPreparation ? closedEditorial(collection) : collection),
  db: serializeDatabaseTransactions(sqliteAdapter({
    client: { url: requireEnvironment("PAYLOAD_DATABASE_URL") ?? "file:./platform-data/payload.sqlite" },
    migrationDir: path.resolve(dirname, "migrations"),
    push: process.env.NODE_ENV !== "production",
    transactionOptions: {},
    wal: true,
    busyTimeout: 5000,
  })),
  jobs: {
    // Payload schedules jobs before evaluating shouldAutoRun. Closed canary must
    // not register a cron at all, otherwise scheduling still writes to SQLite.
    autoRun: canaryPreparation ? [] : [{ cron: "*/5 * * * *", queue: "default", limit: 50 }],
    shouldAutoRun: async () => process.env.PAYLOAD_JOBS_ENABLED !== "false",
    tasks: [syncCourseManifestTask, reconcileCourseManifestsTask],
  },
  plugins: [platformSearchPlugin, s3Storage({
    acl: "public-read",
    alwaysInsertFields: true,
    bucket: s3Bucket ?? "local-media",
    collections: {
      media: {
        generateFileURL: publicMediaFileURL,
        prefix: "media",
      },
    },
    config: s3Config,
    enabled: Boolean(s3Bucket),
  })],
  sharp,
  typescript: { outputFile: path.resolve(dirname, "payload-types.ts") },
});
