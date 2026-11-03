const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_NAME ||= "test_database";
process.env.DB_USER ||= "test_user";
process.env.DB_PASSWORD ||= "test_password";

const app = require("../server");
let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (!server) return;
  server.close();
  await once(server, "close");
});

test("embedded Shopify launch redirect preserves shop, host, and embedded", async () => {
  const response = await fetch(`${baseUrl}/?shop=sample-shop.myshopify.com&host=YWRtaW4uc2hvcGlmeS5jb20vc3RvcmU&embedded=1`, { redirect: "manual" });
  const location = new URL(response.headers.get("location"), baseUrl);

  assert.equal(response.status, 302);
  assert.equal(location.pathname, "/admin");
  assert.equal(location.searchParams.get("shop"), "sample-shop.myshopify.com");
  assert.equal(location.searchParams.get("host"), "YWRtaW4uc2hvcGlmeS5jb20vc3RvcmU");
  assert.equal(location.searchParams.get("embedded"), "1");
});

test("redirect safely encodes parameter values and keeps other Shopify launch parameters", async () => {
  const query = new URLSearchParams({
    shop: "sample-shop.myshopify.com",
    host: "admin.shopify.com/store/a+b /c==",
    embedded: "1",
    locale: "en-US",
    id_token: "token+part/with space="
  });
  const response = await fetch(`${baseUrl}/?${query.toString()}`, { redirect: "manual" });
  const locationHeader = response.headers.get("location");
  const location = new URL(locationHeader, baseUrl);

  assert.equal(location.pathname, "/admin");
  assert.equal(location.searchParams.get("host"), "admin.shopify.com/store/a+b /c==");
  assert.equal(location.searchParams.get("id_token"), "token+part/with space=");
  assert.equal(location.searchParams.get("locale"), "en-US");
  assert.match(locationHeader, /host=admin\.shopify\.com%2Fstore%2Fa%2Bb\+%2Fc%3D%3D/);
  assert.match(locationHeader, /id_token=token%2Bpart%2Fwith\+space%3D/);
});

test("redirect handles missing optional Shopify parameters", async () => {
  const response = await fetch(`${baseUrl}/?shop=sample-shop.myshopify.com`, { redirect: "manual" });
  const location = new URL(response.headers.get("location"), baseUrl);

  assert.equal(response.status, 302);
  assert.equal(location.pathname, "/admin");
  assert.equal(location.searchParams.get("shop"), "sample-shop.myshopify.com");
  assert.equal(location.searchParams.has("host"), false);
  assert.equal(location.searchParams.has("embedded"), false);
});

test("non-Shopify homepage behavior remains unchanged", async () => {
  const response = await fetch(`${baseUrl}/`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /<h1>Shopify Composite App<\/h1>/);
  assert.match(body, /action="\/auth\/install"/);
  assert.match(body, /Health: <a href="\/health">\/health<\/a>/);
});
