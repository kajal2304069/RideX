import { pool } from "../../src/db/pool";

export async function resetAuthTables() {
  await pool.query(`TRUNCATE refresh_tokens, users RESTART IDENTITY CASCADE`);
}

export async function closeTestDb() {
  await pool.end();
}
