import { migrate, openDatabase } from "./db";
import { applyLaunchSeed, readLaunchCatalogue } from "./launch-seed";

const sqlite = openDatabase();
// `migrate` decides lineage before it applies anything, so a database this
// build must not write to is refused here rather than by the seed.
migrate(sqlite);
const catalogue = readLaunchCatalogue();
const outcome = applyLaunchSeed(sqlite, catalogue);
sqlite.close();
// Both outcomes are a success, and the exit code says so. A retry whose first
// attempt committed and lost its response must not read as a failure.
console.log(outcome.kind === "APPLIED"
  ? `Launch seed applied: ${outcome.citiesInserted} cities (${outcome.catalogueSha256}).`
  : `Launch seed already applied with this exact catalogue (${outcome.catalogueSha256}); nothing to do.`);
