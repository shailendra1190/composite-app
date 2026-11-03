
const crypto = require("crypto");

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function getAppUrl() {
  return requiredEnv("APP_URL").replace(/\/+$/, "");
}

function getScopes() {
  return requiredEnv("SHOPIFY_SCOPES");
}

function isValidShop(shop) {
  return typeof shop === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
}

function safeEqualHex(a, b) {
  if (!/^[a-f0-9]+$/i.test(a) || !/^[a-f0-9]+$/i.test(b) || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function verifyCallbackHmac(query) {
  const supplied = query.hmac;
  if (typeof supplied !== "string") return false;

  const message = Object.keys(query)
    .filter((key) => key !== "hmac" && key !== "signature")
    .sort()
    .map((key) => `${key}=${Array.isArray(query[key]) ? query[key].join(",") : query[key]}`)
    .join("&");

  const digest = crypto
    .createHmac("sha256", requiredEnv("SHOPIFY_API_SECRET"))
    .update(message)
    .digest("hex");

  return safeEqualHex(digest, supplied);
}

function encryptionKey() {
  // Derive a fixed 32-byte key from the private Hostinger environment value.
  return crypto.createHash("sha256")
    .update(requiredEnv("APP_ENCRYPTION_KEY"), "utf8")
    .digest();
}

function encryptAccessToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":");
}

function decryptAccessToken(payload) {
  const [version, ivB64, tagB64, dataB64] = String(payload || "").split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("Unsupported encrypted access-token format");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final()
  ]).toString("utf8");
}

module.exports = {
  requiredEnv, getAppUrl, getScopes, isValidShop,
  verifyCallbackHmac, encryptAccessToken, decryptAccessToken
};
