import { migrate, openDatabase } from "./db";
import { applyLaunchSeed, readLaunchCatalogue } from "./launch-seed";

const sqlite = openDatabase();
// `migrate` decides lineage before it applies anything, so a database this
// build must not write to is refused here rather than by the seed.
migrate(sqlite);
const catalogue = readLaunchCatalogue();
const { citiesInserted } = applyLaunchSeed(sqlite, catalogue);
sqlite.close();
console.log(`Launch seed applied: ${citiesInserted} cities.`);
