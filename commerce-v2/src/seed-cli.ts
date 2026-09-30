import { migrateV2, openV2Database } from "./db";
import { applyV2Seed, readV2Catalogue } from "./seed";

const db = openV2Database();
migrateV2(db);
const result = applyV2Seed(db, readV2Catalogue());
db.close();
console.log(result.kind === "APPLIED" ? `V2 launch seed applied (${result.digest}).` : `V2 launch seed already applied (${result.digest}).`);
