
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
  const configured = requiredEnv("SHOPIFY_SCOPES")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (!configured.includes("read_products")) {
    throw new Error("SHOPIFY_SCOPES must include read_products for the Admin product picker.");
  }
  // This milestone only reads products and variants; don't request unused grants
  // even if a host still has the former broader example value configured.
  return "read_products";
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

function verifySessionToken(token, expectedShop) {
  if (typeof token !== "string" || token.length > 12000) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [headerPart, payloadPart, signaturePart] = parts;
  try {
    const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
    const claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    if (header.alg !== "HS256" || header.typ !== "JWT") return false;
    const expected = crypto.createHmac("sha256", requiredEnv("SHOPIFY_API_SECRET"))
      .update(`${headerPart}.${payloadPart}`).digest();
    const supplied = Buffer.from(signaturePart, "base64url");
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return false;

    const now = Math.floor(Date.now() / 1000);
    const shop = String(expectedShop || "").toLowerCase();
    const dest = new URL(claims.dest);
    return claims.aud === requiredEnv("SHOPIFY_API_KEY") &&
      claims.iss === `https://${shop}/admin` &&
      dest.protocol === "https:" && dest.hostname.toLowerCase() === shop &&
      !dest.username && !dest.password && !dest.port && dest.pathname === "/" &&
      Number.isFinite(claims.exp) && claims.exp > now &&
      Number.isFinite(claims.nbf) && claims.nbf <= now;
  } catch {
    return false;
  }
}

module.exports = {
  requiredEnv, getAppUrl, getScopes, isValidShop,
  verifyCallbackHmac, encryptAccessToken, decryptAccessToken, verifySessionToken
};
