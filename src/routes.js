const express = require("express");
const crypto = require("crypto");
const { checkDatabase, pool } = require("./db");
const {
  requiredEnv, getAppUrl, getScopes, isValidShop,
  verifyCallbackHmac, encryptAccessToken
} = require("./shopify");

const router = express.Router();
router.use(require("./admin"));
const STATE_COOKIE = "shopify_oauth_state";

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => {
    const index = part.indexOf("=");
    if (index < 0) return ["", ""];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function setStateCookie(res, state) {
  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/auth/callback",
    maxAge: 10 * 60 * 1000
  });
}

function clearStateCookie(res) {
  res.clearCookie(STATE_COOKIE, {
    httpOnly: true, secure: true, sameSite: "lax", path: "/auth/callback"
  });
}

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

// Start Shopify's authorization-code installation flow.
router.get("/auth/install", (req, res) => {
  try {
    const shop = String(req.query.shop || "").toLowerCase();
    if (!isValidShop(shop)) {
      return res.status(400).send("Invalid shop. Use your-store.myshopify.com");
    }

    const state = crypto.randomBytes(24).toString("hex");
    setStateCookie(res, state);

    const authorizeUrl = new URL(`https://${shop}/admin/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", requiredEnv("SHOPIFY_API_KEY"));
    authorizeUrl.searchParams.set("scope", getScopes());
    authorizeUrl.searchParams.set("redirect_uri", `${getAppUrl()}/auth/callback`);
    authorizeUrl.searchParams.set("state", state);

    res.redirect(authorizeUrl.toString());
  } catch (error) {
    console.error("OAuth install start failed:", error.message);
    res.status(500).send("Shopify installation could not be started. Check the app environment settings.");
  }
});

// Shopify redirects here after the merchant approves the requested access.
router.get("/auth/callback", async (req, res) => {
  try {
    const query = req.query;
    const shop = String(query.shop || "").toLowerCase();
    const cookies = parseCookies(req.headers.cookie);
    const stateCookie = cookies[STATE_COOKIE];

    if (!isValidShop(shop)) return res.status(400).send("Invalid Shopify store.");
    if (!verifyCallbackHmac(query)) return res.status(400).send("Shopify callback signature is invalid.");
    if (!stateCookie || typeof query.state !== "string" || stateCookie !== query.state) {
      return res.status(403).send("Shopify authorization state did not match. Please try installing again.");
    }
    if (typeof query.code !== "string" || !query.code) {
      return res.status(400).send("Shopify did not return an authorization code.");
    }

    const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        client_id: requiredEnv("SHOPIFY_API_KEY"),
        client_secret: requiredEnv("SHOPIFY_API_SECRET"),
        code: query.code
      })
    });

    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) {
      // Never log response bodies from credential endpoints.
      console.error(`Shopify token exchange failed with HTTP status ${tokenResponse.status}.`);
      return res.status(502).send("Shopify could not complete installation. Please try again.");
    }

    const encryptedToken = encryptAccessToken(tokenData.access_token);
    const scopes = tokenData.scope || getScopes();

    await pool.execute(
      `INSERT INTO shops
        (shop_domain, access_token_encrypted, scopes, installed_at, installation_generation_at, uninstalled_at)
       VALUES (?, ?, ?, NOW(), UTC_TIMESTAMP(6), NULL)
       ON DUPLICATE KEY UPDATE
        access_token_encrypted = VALUES(access_token_encrypted),
        scopes = VALUES(scopes),
        installed_at = NOW(),
        installation_generation_at = UTC_TIMESTAMP(6),
        uninstalled_at = NULL`,
      [shop, encryptedToken, scopes]
    );

    clearStateCookie(res);
    res.redirect(`${getAppUrl()}/?shop=${encodeURIComponent(shop)}&installed=1`);
  } catch (error) {
    // Errors from the token exchange or persistence path can carry sensitive context.
    console.error("Shopify OAuth callback failed during installation processing.");
    res.status(500).send("Installation could not be completed. Check the app logs or contact support.");
  }
});

module.exports = router;
