import { migrate, openDatabase } from "./db";
import { loadCanonicalLegalRelease, publishLegalRelease } from "./legal-release";

const sqlite = openDatabase();
try {
  migrate(sqlite);
  const result = publishLegalRelease(sqlite, loadCanonicalLegalRelease());
  console.log(JSON.stringify({ legal_release_id: result.id, version: result.version, manifest_sha256: result.manifestSha256, published: result.published }));
} finally {
  sqlite.close();
}
