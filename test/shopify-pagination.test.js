const test = require("node:test");
const assert = require("node:assert/strict");
const { getCursorPage, readCursor } = require("../src/shopify-pagination");

test("returns one product page and the cursor for the next request", async () => {
  let received;
  const page = await getCursorPage(async ({ after, first }) => {
    received = { after, first };
    return {
      edges: [{ node: { id: "p-2", title: "Second" } }],
      pageInfo: { hasNextPage: true, endCursor: "cursor-2" }
    };
  }, { cursor: "cursor-1", first: 10, mapNode: (node) => node.id });

  assert.deepEqual(received, { after: "cursor-1", first: 10 });
  assert.deepEqual(page, { items: ["p-2"], pageInfo: { hasNextPage: true, endCursor: "cursor-2" } });
});

test("returns a final variant page without a next cursor", async () => {
  const page = await getCursorPage(async () => ({
    edges: [{ node: { id: "v-1" } }],
    pageInfo: { hasNextPage: false, endCursor: "cursor-final" }
  }), { cursor: "cursor-250", first: 250 });

  assert.deepEqual(page, { items: [{ id: "v-1" }], pageInfo: { hasNextPage: false, endCursor: null } });
});

test("rejects missing, repeated, and malformed Shopify cursors", async () => {
  assert.throws(() => readCursor(undefined, true), { status: 400 });
  assert.throws(() => readCursor("x".repeat(2049)), { status: 400 });
  await assert.rejects(getCursorPage(async () => ({
    edges: [], pageInfo: { hasNextPage: true, endCursor: "same" }
  }), { cursor: "same", first: 10 }), { status: 502 });
  await assert.rejects(getCursorPage(async () => ({ edges: [], pageInfo: { hasNextPage: true, endCursor: null } }), { first: 10 }), { status: 502 });
});
