const axios = require("axios");
const https = require("https");

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

module.exports = {
  httpAgent,
  getData,
  withTimeout,
  getUrlParam,
};
