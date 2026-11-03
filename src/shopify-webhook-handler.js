const crypto = require("crypto");
const { isValidShop } = require("./shopify");

function verifyWebhookHmac(rawBody, supplied, secret) {
  if (!Buffer.isBuffer(rawBody) || typeof supplied !== "string" || !secret) return false;
  if (!/^[A-Za-z0-9+/]{43}=$/.test(supplied)) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  const signature = Buffer.from(supplied, "base64");
  return signature.length === expected.length && crypto.timingSafeEqual(signature, expected) &&
    signature.toString("base64") === supplied;
}

function response(status, body, retryAfter) {
  return { status, body, retryAfter };
}

function parseShopifyTriggeredAt(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!match) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== match[1]) return null;
  const fraction = (match[2] || "").padEnd(6, "0");
  return { date, sqlUtc: `${match[1].replace("T", " ")}.${fraction}` };
}

async function handleShopifyWebhook({ rawBody, headers, pool, secret }) {
  const getHeader = (name) => headers?.[name.toLowerCase()];
  if (!verifyWebhookHmac(rawBody, getHeader("x-shopify-hmac-sha256"), secret)) {
    return response(401, { ok: false, error: "Invalid webhook signature" });
  }

  if (String(getHeader("x-shopify-topic") || "").toLowerCase() !== "app/uninstalled") {
    return response(200, { ok: true, ignored: true });
  }

  const shop = String(getHeader("x-shopify-shop-domain") || "").toLowerCase();
  if (!isValidShop(shop)) return response(400, { ok: false, error: "Invalid shop domain" });
  const triggeredAt = parseShopifyTriggeredAt(getHeader("x-shopify-triggered-at"));
  if (!triggeredAt || triggeredAt.date.getTime() > Date.now() + 30000) {
    return response(400, { ok: false, error: "Invalid webhook timestamp" });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return response(400, { ok: false, error: "Invalid webhook payload" });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      typeof payload.id !== "number" || !Number.isFinite(payload.id) || payload.id <= 0 ||
      typeof payload.name !== "string" || !Object.prototype.hasOwnProperty.call(payload, "myshopify_domain") ||
      (payload.myshopify_domain !== null &&
       (typeof payload.myshopify_domain !== "string" || payload.myshopify_domain.toLowerCase() !== shop))) {
    return response(400, { ok: false, error: "Webhook shop does not match its payload" });
  }

  const [result] = await pool.execute(
    `UPDATE shops
       SET access_token_encrypted = NULL, uninstalled_at = NOW()
     WHERE shop_domain = ?
       AND uninstalled_at IS NULL
       AND installation_generation_at IS NOT NULL
       AND installation_generation_at < ?`,
    [shop, triggeredAt.sqlUtc]
  );
  return response(200, { ok: true, processed: result.affectedRows > 0 });
}

module.exports = { verifyWebhookHmac, handleShopifyWebhook, parseShopifyTriggeredAt };
