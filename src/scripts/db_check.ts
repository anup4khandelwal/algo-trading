import dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config();

const REQUIRED_TABLES = ["orders", "fills", "positions", "managed_positions"];

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DB_CHECK_FAIL: DATABASE_URL is not set");
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query("SELECT 1");
    const missing: string[] = [];

    for (const table of REQUIRED_TABLES) {
      const result = await pool.query<{ exists: string | null }>(
        "SELECT to_regclass($1) AS exists",
        [`public.${table}`]
      );
      if (!result.rows[0]?.exists) {
        missing.push(table);
      }
    }

    if (missing.length > 0) {
      console.error(`DB_CHECK_FAIL: Missing tables: ${missing.join(", ")}`);
      process.exitCode = 1;
      return;
    }

    console.log("DB_CHECK_OK: Connected and all required tables exist");
  } catch (err) {
    console.error("DB_CHECK_FAIL: Unable to connect or query database");
    console.error(err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

await main();
