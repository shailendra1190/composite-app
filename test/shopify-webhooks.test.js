const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { verifyWebhookHmac, handleShopifyWebhook, parseShopifyTriggeredAt } = require("../src/shopify-webhook-handler");

const secret = "test-webhook-secret";
const shop = "example.myshopify.com";
const rawBody = Buffer.from(JSON.stringify({ id: 12345, name: "Example", myshopify_domain: null }));
const signature = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
const triggeredAt = new Date(Date.now() - 5000).toISOString();
const sqlTimestamp = `${triggeredAt.slice(0, 19).replace("T", " ")}.${triggeredAt.slice(20, 23)}000`;
const headers = {
  "x-shopify-hmac-sha256": signature,
  "x-shopify-topic": "app/uninstalled",
  "x-shopify-shop-domain": shop,
  "x-shopify-triggered-at": triggeredAt,
  "x-shopify-webhook-id": "delivery-123"
};

test("verifies Shopify webhook HMAC against the unmodified raw body", () => {
  assert.equal(verifyWebhookHmac(rawBody, signature, secret), true);
  assert.equal(verifyWebhookHmac(Buffer.from(`${rawBody} `), signature, secret), false);
  assert.equal(verifyWebhookHmac(rawBody, `${signature}x`, secret), false);
  assert.equal(verifyWebhookHmac(rawBody.toString("utf8"), signature, secret), false);
});

test("parses valid UTC webhook timestamps and preserves microseconds for ordering", () => {
  assert.deepEqual(parseShopifyTriggeredAt("2026-11-03T12:34:56.123456Z"), {
    date: new Date("2026-11-03T12:34:56.123Z"),
    sqlUtc: "2026-11-03 12:34:56.123456"
  });
  assert.equal(parseShopifyTriggeredAt("2026-02-30T12:34:56Z"), null);
  assert.equal(parseShopifyTriggeredAt("2026-11-03T12:34:56+00:00"), null);
});

test("marks only the addressed shop uninstalled and clears its encrypted token", async () => {
  const calls = [];
  const result = await handleShopifyWebhook({
    rawBody, headers, secret,
    pool: { execute: async (...args) => { calls.push(args); return [{ affectedRows: 1 }]; } }
  });

  assert.deepEqual(result, { status: 200, body: { ok: true, processed: true }, retryAfter: undefined });
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /SET access_token_encrypted = NULL, uninstalled_at = NOW\(\)/);
  assert.match(calls[0][0], /WHERE shop_domain = \?/);
  assert.match(calls[0][0], /installation_generation_at IS NOT NULL/);
  assert.match(calls[0][0], /installation_generation_at < \?/);
  assert.deepEqual(calls[0][1], [shop, sqlTimestamp]);
});

test("an uninstall event older than the latest install cannot invalidate its token", async () => {
  const oldRawBody = Buffer.from(JSON.stringify({ id: 12345, name: "Example", myshopify_domain: null }));
  const oldTriggeredAt = new Date(Date.now() - 5000).toISOString();
  const eventSqlTimestamp = `${oldTriggeredAt.slice(0, 19).replace("T", " ")}.${oldTriggeredAt.slice(20, 23)}000`;
  const installGeneration = `${new Date(Date.parse(oldTriggeredAt) + 500).toISOString().slice(0, 19).replace("T", " ")}.${String(new Date(Date.parse(oldTriggeredAt) + 500).getUTCMilliseconds()).padStart(3, "0")}000`;
  const oldHeaders = {
    ...headers,
    "x-shopify-triggered-at": oldTriggeredAt,
    "x-shopify-hmac-sha256": crypto.createHmac("sha256", secret).update(oldRawBody).digest("base64")
  };
  let tokenInvalidated = false;
  const result = await handleShopifyWebhook({
    rawBody: oldRawBody,
    headers: oldHeaders,
    secret,
    pool: { execute: async (sql, params) => {
      assert.match(sql, /installation_generation_at < \?/);
      assert.deepEqual(params, [shop, eventSqlTimestamp]);
      if (params[1] > installGeneration) tokenInvalidated = true;
      return [{ affectedRows: tokenInvalidated ? 1 : 0 }];
    } }
  });
  assert.equal(tokenInvalidated, false);
  assert.deepEqual(result.body, { ok: true, processed: false });
});

test("rejects forged signatures and mismatched signed shop identity without database writes", async () => {
  let writes = 0;
  const pool = { execute: async () => { writes++; return [{ affectedRows: 1 }]; } };
  const forged = await handleShopifyWebhook({ rawBody, headers: { ...headers, "x-shopify-hmac-sha256": "bad" }, pool, secret });
  assert.equal(forged.status, 401);
  const mismatched = await handleShopifyWebhook({
    rawBody: Buffer.from(JSON.stringify({ id: 12345, name: "Example", myshopify_domain: "other.myshopify.com" })),
    headers: { ...headers, "x-shopify-hmac-sha256": crypto.createHmac("sha256", secret).update(JSON.stringify({ id: 12345, name: "Example", myshopify_domain: "other.myshopify.com" })).digest("base64") },
    pool, secret
  });
  assert.equal(mismatched.status, 400);
  assert.equal(writes, 0);
});

test("treats duplicate uninstall deliveries idempotently and ignores other topics", async () => {
  let writes = 0;
  const pool = { execute: async () => { writes++; return [{ affectedRows: 0 }]; } };
  const duplicate = await handleShopifyWebhook({ rawBody, headers, pool, secret });
  assert.deepEqual(duplicate.body, { ok: true, processed: false });
  const ignored = await handleShopifyWebhook({ rawBody, headers: { ...headers, "x-shopify-topic": "products/update" }, pool, secret });
  assert.deepEqual(ignored.body, { ok: true, ignored: true });
  assert.equal(writes, 1);
});
