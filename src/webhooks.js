const express = require("express");
const { pool } = require("./db");
const { requiredEnv } = require("./shopify");
const { handleShopifyWebhook } = require("./shopify-webhook-handler");

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const result = await handleShopifyWebhook({
      rawBody: req.body,
      headers: req.headers,
      pool,
      secret: requiredEnv("SHOPIFY_API_SECRET")
    });
    if (result.retryAfter) res.set("Retry-After", String(result.retryAfter));
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error("Shopify uninstall webhook processing failed:", error.message);
    res.status(500).json({ ok: false, error: "Webhook processing failed" });
  }
});

module.exports = router;
