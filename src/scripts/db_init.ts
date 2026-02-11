import dotenv from "dotenv";
import { PostgresPersistence } from "../persistence/postgres_persistence.js";

dotenv.config();

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DB_INIT_FAIL: DATABASE_URL is not set");
    process.exitCode = 1;
    return;
  }

  try {
    const persistence = new PostgresPersistence(databaseUrl);
    await persistence.init();
    console.log("DB_INIT_OK: Required tables are created/ready");
  } catch (err) {
    console.error("DB_INIT_FAIL: Unable to initialize database schema");
    console.error(err);
    process.exitCode = 1;
  }
}

await main();
