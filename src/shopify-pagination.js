function paginationError(message) {
  return Object.assign(new Error(message), { status: 502 });
}

function readCursor(value, required = false) {
  if (value === undefined || value === null || value === "") {
    if (required) throw Object.assign(new Error("A pagination cursor is required."), { status: 400 });
    return null;
  }
  if (typeof value !== "string" || !value.trim() || value.length > 2048) {
    throw Object.assign(new Error("The pagination cursor is invalid."), { status: 400 });
  }
  return value;
}

async function getCursorPage(fetchPage, { cursor = null, first, mapNode = (node) => node }) {
  const connection = await fetchPage({ after: cursor, first });
  const pageInfo = connection?.pageInfo;
  if (!Array.isArray(connection?.edges) || typeof pageInfo?.hasNextPage !== "boolean") {
    throw paginationError("Shopify returned an invalid paginated response.");
  }
  if (pageInfo.hasNextPage &&
      (typeof pageInfo.endCursor !== "string" || !pageInfo.endCursor || pageInfo.endCursor === cursor)) {
    throw paginationError("Shopify did not return a usable cursor for the next page.");
  }
  return {
    items: connection.edges.map((edge) => mapNode(edge?.node)),
    pageInfo: {
      hasNextPage: pageInfo.hasNextPage,
      endCursor: pageInfo.hasNextPage ? pageInfo.endCursor : null
    }
  };
}

module.exports = { readCursor, getCursorPage };
