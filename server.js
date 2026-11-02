require("dotenv").config();

const express = require("express");
const routes = require("./src/routes");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use("/", routes);

app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shopify Composite App</title></head>
<body style="font-family:Arial,sans-serif;max-width:720px;margin:60px auto;padding:0 20px">
<h1>Shopify Composite App</h1>
<p>Application server is running.</p>
<p>Health: <a href="/health">/health</a></p>
<p>Database check: <a href="/health/db">/health/db</a></p>
</body></html>`);
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: "Internal server error" });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () => {
  console.log(`Shopify Composite App listening on port ${port}`);
});
