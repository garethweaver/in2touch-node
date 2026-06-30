const axios = require("axios");
const https = require("https");
const pLimit = require("p-limit");

// Configure axios defaults
axios.defaults.timeout = 60000; // 60 second timeout
axios.defaults.maxRedirects = 3;
axios.defaults.validateStatus = (status) => status < 500; // Don't retry on 4xx errors

// Configure HTTP agent with timeouts for Firebase Admin SDK (not axios)
const httpAgent = new https.Agent({
  keepAlive: false, // Disable keep-alive to prevent hanging connections
  timeout: 60000, // 60 second timeout - fail fast
  maxSockets: 10,
});

// Limit concurrent HTTP requests to avoid overwhelming the server
const limit = pLimit(5); // Max 5 concurrent requests

const getData = async (url) => {
  try {
    console.info(`Requesting ${url}`);
    const response = await axios(url);
    return response.data;
  } catch (e) {
    if (e?.response) {
      console.error(
        "⚠️",
        e.response.status,
        e.response.statusText,
        e.config.url,
      );
    } else {
      console.error(e);
    }
    return null;
  }
};

// Smart timeout wrapper that handles both promises and functions
const withTimeout = async (promiseOrFn, timeoutMs = 15000) => {
  const promise =
    typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn;
  const timeoutSeconds = timeoutMs / 1000;
  const timeDisplay =
    timeoutSeconds >= 60
      ? `${timeoutSeconds / 60} minutes`
      : `${timeoutSeconds} seconds`;

  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Operation timeout after ${timeDisplay}`)),
        timeoutMs,
      ),
    ),
  ]);
};

const getUrlParam = (url, param) => {
  const u = new URL(url);
  return u.searchParams.get(param);
};

/**
 * Fetch data in parallel with concurrency control using p-limit
 * @param {Array} items - Array of items to process
 * @param {Function} fetcherFn - Async function that takes an item and returns data (or null on error)
 * @returns {Promise<Array>} Array of successful results
 *
 * @example
 * const results = await fetchInParallel(
 *   leagueIds,
 *   async (id) => {
 *     const html = await getData(url);
 *     return html ? { id, html } : null;
 *   }
 * );
 */
const fetchInParallel = async (items, fetcherFn) => {
  const results = await Promise.allSettled(
    items.map((item) => limit(() => fetcherFn(item))),
  );

  return results
    .filter((result) => result.status === "fulfilled" && result.value !== null)
    .map((result) => result.value);
};

module.exports = {
  httpAgent,
  getData,
  withTimeout,
  getUrlParam,
  fetchInParallel,
  limit,
};
