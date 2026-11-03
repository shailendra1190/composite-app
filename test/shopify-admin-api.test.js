const test = require("node:test");
const assert = require("node:assert/strict");
const { requestShopifyGraphql } = require("../src/shopify-admin-api");

function response(status, body, retryAfter) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => name === "retry-after" ? retryAfter || null : null },
    json: async () => body
  };
}

const input = { shop: "example.myshopify.com", accessToken: "token", version: "2026-10", query: "query Test { shop { id } }" };

test("retries HTTP rate limits and returns the successful GraphQL page", async () => {
  let attempts = 0;
  const waits = [];
  const result = await requestShopifyGraphql({
    ...input,
    fetchImpl: async () => ++attempts === 1 ? response(429, {}, "0") : response(200, { data: { shop: { id: "shop-1" } } }),
    waitImpl: async (duration) => waits.push(duration)
  });
  assert.equal(result.shop.id, "shop-1");
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [250]);
});

test("retries GraphQL THROTTLED errors and reports exhaustion with Retry-After", async () => {
  let attempts = 0;
  await assert.rejects(requestShopifyGraphql({
    ...input,
    fetchImpl: async () => { attempts++; return response(200, { errors: [{ extensions: { code: "THROTTLED" } }] }); },
    waitImpl: async () => {}
  }), (error) => error.status === 429 && error.retryAfter >= 1);
  assert.equal(attempts, 3);
});

test("preserves Shopify's longer Retry-After after bounded automatic retries", async () => {
  const waits = [];
  await assert.rejects(requestShopifyGraphql({
    ...input,
    fetchImpl: async () => response(429, {}, "60"),
    waitImpl: async (duration) => waits.push(duration)
  }), (error) => error.status === 429 && error.retryAfter === 60);
  assert.deepEqual(waits, [10000, 10000]);
});

test("surfaces non-rate-limit Shopify failures as a gateway error", async () => {
  await assert.rejects(requestShopifyGraphql({
    ...input,
    fetchImpl: async () => response(503, { errors: [] }),
    waitImpl: async () => assert.fail("Should not retry this error")
  }), { status: 502 });
});
