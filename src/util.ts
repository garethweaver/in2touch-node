import axios from "axios";
import https from "node:https";
import pLimit from "p-limit";

// Configure axios defaults
axios.defaults.timeout = 60000; // 60 second timeout
axios.defaults.maxRedirects = 3;
axios.defaults.validateStatus = (status) => status < 500; // Don't retry on 4xx errors

// Configure HTTP agent with timeouts for Firebase Admin SDK (not axios)
export const httpAgent = new https.Agent({
  keepAlive: false, // Disable keep-alive to prevent hanging connections
  timeout: 60000, // 60 second timeout - fail fast
  maxSockets: 10,
});

// Limit concurrent HTTP requests to avoid overwhelming the server
export const limit = pLimit(5); // Max 5 concurrent requests

export const getData = async (url: string): Promise<string | null> => {
  try {
    console.info(`Requesting ${url}`);
    const response = await axios<string>(url);
    return response.data;
  } catch (e) {
    if (axios.isAxiosError(e) && e.response) {
      console.error(
        "⚠️",
        e.response.status,
        e.response.statusText,
        e.config?.url,
      );
    } else {
      console.error(e);
    }
    return null;
  }
};

// Smart timeout wrapper that handles both promises and functions
export const withTimeout = async <T>(
  promiseOrFn: T | Promise<T> | (() => T | Promise<T>),
  timeoutMs = 15000,
): Promise<T> => {
  const promise =
    typeof promiseOrFn === "function"
      ? (promiseOrFn as () => T | Promise<T>)()
      : promiseOrFn;
  const timeoutSeconds = timeoutMs / 1000;
  const timeDisplay =
    timeoutSeconds >= 60
      ? `${timeoutSeconds / 60} minutes`
      : `${timeoutSeconds} seconds`;

  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Operation timeout after ${timeDisplay}`)),
        timeoutMs,
      ),
    ),
  ]);
};

export const getUrlParam = (url: string, param: string): string | null => {
  const u = new URL(url);
  return u.searchParams.get(param);
};

/**
 * Fetch data in parallel with concurrency control using p-limit
 * @returns Array of successful (non-null) results
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
export const fetchInParallel = async <I, R>(
  items: I[],
  fetcherFn: (item: I) => Promise<R | null>,
): Promise<R[]> => {
  const results = await Promise.allSettled(
    items.map((item) => limit(() => fetcherFn(item))),
  );

  return results
    .filter(
      (result): result is PromiseFulfilledResult<Awaited<R>> =>
        result.status === "fulfilled" && result.value !== null,
    )
    .map((result) => result.value);
};
