import { migrate, openDatabase } from "./db";
import { CommerceDomain } from "./domain";
import { MockProvider } from "./provider";

const requestId = process.env.COMMERCE_CITY_INTEREST_REPAIR_REQUEST_ID;
const confirmation = process.env.COMMERCE_CITY_INTEREST_REPAIR_CONFIRM;

if (!requestId || confirmation !== requestId) {
  throw new Error("Set COMMERCE_CITY_INTEREST_REPAIR_REQUEST_ID and COMMERCE_CITY_INTEREST_REPAIR_CONFIRM to the same request ID.");
}

const db = openDatabase();
try {
  migrate(db);
  const repaired = new CommerceDomain(db, new MockProvider()).repairDeliveredCityInterestOrphan(requestId);
  console.log(JSON.stringify({ request_id: requestId, repaired }));
} finally {
  db.close();
}
