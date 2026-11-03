const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

process.env.SHOPIFY_API_KEY = "test-client-id";
process.env.SHOPIFY_API_SECRET = "test-client-secret";
process.env.APP_ENCRYPTION_KEY = "test-encryption-key";
process.env.SHOPIFY_SCOPES = "read_products,write_products,read_inventory,read_orders";

const { verifySessionToken, encryptAccessToken, decryptAccessToken, getScopes } = require("../src/shopify");
const shop = "example.myshopify.com";

function createToken(overrides = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    aud: process.env.SHOPIFY_API_KEY,
    iss: `https://${shop}/admin`,
    dest: `https://${shop}`,
    exp: Math.floor(Date.now() / 1000) + 60,
    nbf: Math.floor(Date.now() / 1000) - 1,
    ...overrides
  })).toString("base64url");
  const message = `${header}.${claims}`;
  const signature = crypto.createHmac("sha256", process.env.SHOPIFY_API_SECRET).update(message).digest("base64url");
  return `${message}.${signature}`;
}

test("accepts a valid Shopify session token for the expected shop", () => {
  assert.equal(verifySessionToken(createToken(), shop), true);
});

test("rejects session tokens with a bad signature, audience, expiry, or shop", () => {
  const valid = createToken();
  const replacement = valid.endsWith("A") ? "B" : "A";
  assert.equal(verifySessionToken(`${valid.slice(0, -1)}${replacement}`, shop), false);
  assert.equal(verifySessionToken(createToken({ aud: "another-app" }), shop), false);
  assert.equal(verifySessionToken(createToken({ exp: Math.floor(Date.now() / 1000) - 1 }), shop), false);
  assert.equal(verifySessionToken(createToken({ nbf: Math.floor(Date.now() / 1000) + 5 }), shop), false);
  assert.equal(verifySessionToken(createToken({ nbf: undefined }), shop), false);
  assert.equal(verifySessionToken(createToken({ dest: `https://${shop}/unexpected-path` }), shop), false);
  assert.equal(verifySessionToken(valid, "another-shop.myshopify.com"), false);
});

test("keeps the existing encrypted access-token format readable", () => {
  const token = "shpat_example_private_token";
  const key = crypto.createHash("sha256").update(process.env.APP_ENCRYPTION_KEY, "utf8").digest();
  const iv = Buffer.alloc(12, 7);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const legacyPayload = ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(":");
  assert.equal(decryptAccessToken(legacyPayload), token);
  assert.match(encryptAccessToken(token), /^v1:/);
});

test("requests only the product read scope even when old broader scopes remain configured", () => {
  assert.equal(getScopes(), "read_products");
});
