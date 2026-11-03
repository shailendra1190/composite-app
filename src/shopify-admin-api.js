function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(response, attempt) {
  const header = response?.headers?.get?.("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(250, seconds * 1000);
    const dateDelay = Date.parse(header) - Date.now();
    if (Number.isFinite(dateDelay)) return Math.max(250, dateDelay);
  }
  return Math.min(10000, 1000 * (2 ** attempt));
}

function apiError(status, message, retryAfter, cause) {
  const error = new Error(message);
  error.status = status;
  if (retryAfter !== undefined) error.retryAfter = retryAfter;
  if (cause !== undefined) error.cause = cause;
  return error;
}

async function requestShopifyGraphql({
  shop, accessToken, version, query, variables = {}, fetchImpl = fetch, waitImpl = wait
}) {
  const endpoint = `https://${shop}/admin/api/${encodeURIComponent(version)}/graphql.json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    let data;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20000)
      });
    } catch (cause) {
      throw apiError(502, "Shopify did not respond in time. Please retry.", undefined, cause);
    }
    try {
      data = await response.json();
    } catch (cause) {
      if (response.status === 429) data = null;
      else throw apiError(502, "Shopify returned an invalid response. Please retry.", undefined, { cause });
    }

    const graphErrors = Array.isArray(data?.errors) ? data.errors : [];
    const throttled = response.status === 429 || graphErrors.some((item) => item?.extensions?.code === "THROTTLED");
    if (throttled) {
      const delay = retryDelay(response, attempt);
      if (attempt < 2) {
        await waitImpl(Math.min(delay, 10000));
        continue;
      }
      throw apiError(429, "Shopify is temporarily rate-limiting requests. Wait briefly and retry.", Math.ceil(delay / 1000));
    }
    if (!response.ok || !data || graphErrors.length || !data.data) {
      throw apiError(502, "Shopify could not load product data. Check the app's product access and try again.");
    }
    return data.data;
  }
  throw apiError(502, "Shopify could not load product data. Please retry.");
}

module.exports = { requestShopifyGraphql };
