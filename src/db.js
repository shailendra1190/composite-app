const mysql = require("mysql2/promise");

const required = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"];
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  charset: "utf8mb4"
});

async function checkDatabase() {
  const [rows] = await pool.query("SELECT 1 AS connected");
  return rows[0].connected === 1;
}

module.exports = { pool, checkDatabase };
