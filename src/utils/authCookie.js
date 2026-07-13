/**
 * Auth cookie options for local (same-site) vs deployed (Vercel ↔ API cross-site).
 * Cross-site browsers require SameSite=None and Secure=true.
 */
function useCrossSiteCookies() {
  if (process.env.CROSS_SITE_COOKIES === 'true') return true;
  if (process.env.CROSS_SITE_COOKIES === 'false') return false;
  if (process.env.NODE_ENV === 'production') return true;

  const frontend = String(process.env.FRONTEND_URL || '');
  return frontend.startsWith('https://') && !frontend.includes('localhost');
}

function getAuthCookieOptions(overrides = {}) {
  const crossSite = useCrossSiteCookies();
  return {
    httpOnly: true,
    secure: crossSite,
    sameSite: crossSite ? 'none' : 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

function getClearAuthCookieOptions() {
  const opts = getAuthCookieOptions();
  delete opts.maxAge;
  return opts;
}

module.exports = {
  useCrossSiteCookies,
  getAuthCookieOptions,
  getClearAuthCookieOptions,
};
