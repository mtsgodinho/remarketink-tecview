import "dotenv/config";
import { getDB, migrate } from "../src/lib/db";
await migrate(await getDB());
console.log("Migrations aplicadas.");
process.exit(0);
