/**
 * Gemini API helpers — retry on rate limit + try fallback models.
 */
function isRetiredModelError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  const status = error?.status;
  return (
    status === 404
    || msg.includes('404')
    || msg.includes('is not found')
    || msg.includes('not supported for generatecontent')
  );
}

function isQuotaOrRateLimitError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  const status = error?.status;
  return status === 429 || msg.includes('429') || msg.includes('quota') || msg.includes('rate limit') || msg.includes('too many requests');
}

function parseRetryDelayMs(error) {
  const msg = String(error?.message || '');
  const match = msg.match(/retry in ([\d.]+)s/i);
  if (match) return Math.ceil(parseFloat(match[1]) * 1000) + 500;
  return 3000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry the same call when Google returns 429 (rate limit).
 */
async function withRetry(fn, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isQuotaOrRateLimitError(error) || attempt === maxAttempts) {
        throw error;
      }
      const delay = parseRetryDelayMs(error);
      console.warn(`[gemini] Rate limited — retry ${attempt}/${maxAttempts} in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * Try multiple models when one hits quota (free tier limit per model).
 */
async function withModelFallback(models, runWithModel) {
  const unique = [...new Set(models.filter(Boolean))];
  let lastError;

  for (const model of unique) {
    try {
      return await withRetry(() => runWithModel(model));
    } catch (error) {
      lastError = error;
      if (isQuotaOrRateLimitError(error) || isRetiredModelError(error)) {
        console.warn(
          `[gemini] Model "${model}" unavailable (${isRetiredModelError(error) ? 'not found' : 'quota'}) — trying next…`
        );
        continue;
      }
      throw error;
    }
  }

  throw lastError;
}

/**
 * Short user-friendly message instead of raw Google error JSON.
 */
function formatGeminiErrorForUser(error) {
  if (isQuotaOrRateLimitError(error)) {
    return 'Gemini API quota exceeded. Please wait a few minutes or switch GOOGLE_API_KEY in backend .env.';
  }

  const msg = String(error?.message || error || 'Gemini request failed');
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
    return 'Cannot reach Gemini (DNS/network). Check internet, DNS, or VPN, then retry.';
  }
  if (/ENETUNREACH|ECONNREFUSED|ETIMEDOUT|ECONNRESET/i.test(msg)) {
    return 'Cannot reach Gemini (network error). Check internet and try again.';
  }
  if (msg.length > 200) {
    return msg.slice(0, 200) + '…';
  }
  return msg;
}

module.exports = {
  isQuotaOrRateLimitError,
  isRetiredModelError,
  withRetry,
  withModelFallback,
  formatGeminiErrorForUser,
};
