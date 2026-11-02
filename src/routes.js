const express = require("express");
const { checkDatabase } = require("./db");

const router = express.Router();

router.get("/health", (req, res) => {
  res.json({ ok: true, service: "shopify-composite-app" });
});

router.get("/health/db", async (req, res) => {
  try {
    await checkDatabase();
    res.json({ ok: true, database: "connected" });
  } catch (error) {
    console.error("Database health check failed:", error.message);
    res.status(503).json({
      ok: false,
      database: "not_connected",
      message: "Check the database host, credentials, and Hostinger database permissions."
    });
  }
});

module.exports = router;
