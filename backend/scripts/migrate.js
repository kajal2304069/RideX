require("dotenv/config");
const { join } = require("path");
const runner = require("node-pg-migrate").default;

const direction = process.argv[2] === "down" ? "down" : "up";

runner({
  databaseUrl: process.env.DATABASE_URL,
  dir: join(__dirname, "..", "src", "db", "migrations"),
  migrationsTable: "pgmigrations",
  direction,
  count: direction === "down" ? 1 : Infinity,
  logger: console,
})
  .then(() => {
    console.log(`✅ Migrations (${direction}) complete`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Migration failed:", err);
    process.exit(1);
  });
