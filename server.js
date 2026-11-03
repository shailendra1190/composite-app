require("dotenv").config();

const express = require("express");
const routes = require("./src/routes");
const webhooks = require("./src/webhooks");

const app = express();
app.disable("x-powered-by");
app.use("/webhooks/shopify", express.raw({ type: "application/json", limit: "256kb", inflate: false }), webhooks);
app.use(express.json({ limit: "1mb" }));
app.use("/", routes);

app.get("/", (req, res) => {
  const shop = String(req.query.shop || "").toLowerCase();
  if (/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
    // Keep Shopify's launch context intact across this same-origin redirect.
    // URL parsing and serialization preserve unknown parameters while safely
    // encoding values in the Location header.
    const launchUrl = new URL(req.originalUrl, "http://localhost");
    const adminUrl = new URL("/admin", "http://localhost");
    adminUrl.search = launchUrl.search;
    return res.redirect(`${adminUrl.pathname}${adminUrl.search}`);
  }
  res.type("html").send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shopify Composite App</title></head>
<body style="font-family:Arial,sans-serif;max-width:720px;margin:60px auto;padding:0 20px">
<h1>Shopify Composite App</h1>
<p>Configure composite products from your Shopify Admin.</p>
<form action="/auth/install" method="get">
<label for="shop">Shopify store domain</label>
<input id="shop" name="shop" type="text" placeholder="your-store.myshopify.com" required>
<button type="submit">Install or open app</button>
</form>
<p>Health: <a href="/health">/health</a></p>
<p>Database check: <a href="/health/db">/health/db</a></p>
</body></html>`);
});

app.use((err, req, res, next) => {
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ ok: false, error: status === 413 ? "Request body is too large" : status < 500 ? "Invalid request" : "Internal server error" });
});

const port = Number(process.env.PORT || 3000);
if (require.main === module) {
  app.listen(port, "0.0.0.0", () => {
    console.log(`Shopify Composite App listening on port ${port}`);
  });
}

module.exports = app;
