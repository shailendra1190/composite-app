"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

require("dotenv").config();

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const TRACKING_TABLE = "schema_migrations";
const REQUIRED_COLUMNS = {
  shops: ["id", "shop_domain", "access_token_encrypted", "scopes", "installed_at", "uninstalled_at", "created_at", "updated_at"],
  composite_products: ["id", "shop_id", "shopify_product_id", "title", "enabled", "configuration_json", "created_at", "updated_at"],
  component_groups: ["id", "composite_product_id", "group_key", "name", "description", "selection_type", "is_required", "min_selections", "max_selections", "sort_order", "settings_json", "created_at", "updated_at"],
  component_options: ["id", "component_group_id", "shopify_product_id", "shopify_variant_id", "option_label", "quantity", "is_default", "price_adjustment", "sort_order", "created_at"]
};

function fail(message) {
  throw new Error(message);
}

function checksum(sql) {
  return crypto.createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

function migrationFiles() {
  const names = fs.readdirSync(MIGRATIONS_DIR).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (!names.length) fail("No migration files were found.");
  const versions = names.map((name) => Number(name.slice(0, 4)));
  if (new Set(versions).size !== versions.length || versions.some((version, index) => version !== index + 1)) {
    fail("Migration files must use unique, contiguous four-digit versions starting at 0001.");
  }
  return names.map((filename) => {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), "utf8").trim();
    const match = /^(\d{4})_/.exec(filename);
    if (!sql || !match) fail(`Invalid migration file: ${filename}`);
    return { version: match[1], filename, sql, checksum: checksum(sql) };
  });
}

async function tableExists(connection, name) {
  const [rows] = await connection.execute(
    "SELECT 1 AS present FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1",
    [name]
  );
  return rows.length > 0;
}

async function validateApplicationSchema(connection) {
  for (const [table, expectedColumns] of Object.entries(REQUIRED_COLUMNS)) {
    if (!(await tableExists(connection, table))) {
      fail(`Required existing table '${table}' is missing. Initialize or restore the existing application schema before adopting migrations.`);
    }
    const [rows] = await connection.execute(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?",
      [table]
    );
    const columns = new Set(rows.map((row) => row.COLUMN_NAME || row.column_name));
    const missing = expectedColumns.filter((column) => !columns.has(column));
    if (missing.length) fail(`Table '${table}' is incompatible; missing required columns: ${missing.join(", ")}. No application tables were changed.`);
  }

  const [uniqueRows] = await connection.execute(
    `SELECT table_name, index_name, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns_in_index
       FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND non_unique = 0
        AND ((table_name = 'shops' AND column_name = 'shop_domain')
          OR (table_name = 'composite_products' AND column_name IN ('shop_id', 'shopify_product_id')))
      GROUP BY table_name, index_name`
  );
  const uniqueKeys = new Set(uniqueRows.map((row) => `${row.TABLE_NAME || row.table_name}:${row.columns_in_index}`));
  if (![...uniqueKeys].some((key) => key.startsWith("shops:") && key.endsWith("shop_domain"))) {
    fail("shops.shop_domain must have a unique index for existing OAuth upserts.");
  }
  if (![...uniqueKeys].some((key) => key.startsWith("composite_products:") && key.endsWith("shop_id,shopify_product_id"))) {
    fail("composite_products must have a unique (shop_id, shopify_product_id) index for configuration upserts.");
  }

  const [foreignRows] = await connection.execute(
    `SELECT table_name, column_name, referenced_table_name, referenced_column_name
       FROM information_schema.key_column_usage
      WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL`
  );
  const foreignKeys = new Set(foreignRows.map((row) => `${row.TABLE_NAME || row.table_name}:${row.COLUMN_NAME || row.column_name}->${row.REFERENCED_TABLE_NAME || row.referenced_table_name}.${row.REFERENCED_COLUMN_NAME || row.referenced_column_name}`));
  for (const relation of [
    "composite_products:shop_id->shops.id",
    "component_groups:composite_product_id->composite_products.id",
    "component_options:component_group_id->component_groups.id"
  ]) {
    if (!foreignKeys.has(relation)) fail(`Required existing foreign key '${relation}' is missing.`);
  }
}

async function readApplied(connection) {
  if (!(await tableExists(connection, TRACKING_TABLE))) return null;
  const [rows] = await connection.execute(
    `SELECT version, filename, checksum FROM \`${TRACKING_TABLE}\` ORDER BY version`
  );
  return rows;
}

async function validateTrackingTable(connection) {
  const [rows] = await connection.execute(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?",
    [TRACKING_TABLE]
  );
  const columns = new Set(rows.map((row) => row.COLUMN_NAME || row.column_name));
  for (const column of ["version", "filename", "checksum", "applied_at"]) {
    if (!columns.has(column)) fail("Existing schema_migrations table has an incompatible shape; no migration was run.");
  }
}

async function ensureInstallationGenerationColumn(connection, migration) {
  const readColumn = async () => {
    const [rows] = await connection.execute(
      `SELECT data_type, datetime_precision FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'shops' AND column_name = 'installation_generation_at'`
    );
    return rows[0] || null;
  };
  let column = await readColumn();
  if (!column) {
    await connection.query(migration.sql);
    column = await readColumn();
  }
  const type = String(column?.DATA_TYPE || column?.data_type || "").toLowerCase();
  const precision = Number(column?.DATETIME_PRECISION ?? column?.datetime_precision);
  if (type !== "datetime" || precision !== 6) {
    fail("shops.installation_generation_at must be DATETIME(6); migration 0003 was not recorded.");
  }
}

function validateHistory(applied, migrations) {
  if (!applied) return;
  const known = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const row of applied) {
    const migration = known.get(String(row.version));
    if (!migration || row.filename !== migration.filename || row.checksum !== migration.checksum) {
      fail(`Migration history mismatch at version ${row.version}. Applied migration files must not be edited or removed.`);
    }
  }
  for (let index = 0; index < applied.length; index += 1) {
    if (String(applied[index].version) !== migrations[index]?.version) {
      fail("Migration history is not a contiguous prefix; refusing to apply further migrations.");
    }
  }
}

async function showStatus(connection, migrations) {
  await validateApplicationSchema(connection);
  const applied = await readApplied(connection);
  if (applied) {
    await validateTrackingTable(connection);
    validateHistory(applied, migrations);
  }
  const appliedVersions = new Set((applied || []).map((row) => String(row.version)));
  console.log(`Database schema is compatible. Tracking table: ${applied ? "present" : "not created"}.`);
  for (const migration of migrations) {
    console.log(`${appliedVersions.has(migration.version) ? "applied" : "pending"}  ${migration.version}  ${migration.filename}`);
  }
}

async function applyMigrations(connection, migrations) {
  await validateApplicationSchema(connection);
  await connection.query(`CREATE TABLE IF NOT EXISTS \`${TRACKING_TABLE}\` (
    version VARCHAR(32) NOT NULL,
    filename VARCHAR(255) NOT NULL,
    checksum CHAR(64) NOT NULL,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (version),
    UNIQUE KEY uq_schema_migrations_filename (filename)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await validateTrackingTable(connection);

  const applied = await readApplied(connection);
  validateHistory(applied, migrations);
  const done = new Set(applied.map((row) => String(row.version)));

  for (const migration of migrations) {
    if (done.has(migration.version)) continue;
    // Files intentionally contain one statement. MySQL DDL auto-commits, so the
    // migration must be repeatable if a process stops before its history insert.
    if (migration.version === "0003") {
      // ALTER TABLE auto-commits. Verify the postcondition if a prior attempt
      // added the column but stopped before its history row was inserted.
      await ensureInstallationGenerationColumn(connection, migration);
    } else {
      await connection.query(migration.sql);
    }
    await connection.execute(
      `INSERT INTO \`${TRACKING_TABLE}\` (version, filename, checksum) VALUES (?, ?, ?)`,
      [migration.version, migration.filename, migration.checksum]
    );
    console.log(`applied  ${migration.version}  ${migration.filename}`);
  }
}

async function main() {
  const command = process.argv[2];
  if (!new Set(["status", "up"]).has(command)) {
    fail("Usage: node scripts/migrate.js status | up [--confirm] [--backup-confirmed]");
  }
  if (command === "up" && !process.argv.includes("--confirm")) {
    fail("Refusing to apply migrations without --confirm.");
  }
  if (command === "up" && !process.argv.includes("--backup-confirmed")) {
    fail("Refusing to apply migrations without --backup-confirmed after taking and verifying a database backup.");
  }

  const migrations = migrationFiles();
  // Import only after CLI guard checks; src/db uses the existing DB_* env vars.
  const { pool } = require("../src/db");
  let connection;
  let locked = false;
  try {
    connection = await pool.getConnection();
    if (command === "up") {
      const [lockRows] = await connection.execute("SELECT GET_LOCK(?, 10) AS acquired", ["shopify-composite-schema-migrations"]);
      if (Number(lockRows[0].acquired) !== 1) fail("Could not acquire migration lock; another migration may be running.");
      locked = true;
      await applyMigrations(connection, migrations);
      console.log("All migrations are applied.");
    } else {
      await showStatus(connection, migrations);
    }
  } finally {
    if (locked && connection) await connection.query("SELECT RELEASE_LOCK(?)", ["shopify-composite-schema-migrations"]).catch(() => {});
    if (connection) connection.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Migration command failed: ${error.message}`);
  process.exitCode = 1;
});
