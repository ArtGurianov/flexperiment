import { migrate, openDatabase } from "./db";

const sqlite = openDatabase();
migrate(sqlite);
sqlite.close();
console.log("Commerce migrations applied.");
