import { migrateV2, openV2Database } from "./db";

const db = openV2Database();
migrateV2(db);
db.close();
console.log("Flexperiment v2 merchant migrations applied.");
