import crypto from 'node:crypto';

export function digestEqual(candidate, secret) {
  try {
    const a = crypto.createHash('sha256').update(String(candidate)).digest();
    const b = crypto.createHash('sha256').update(String(secret)).digest();
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function stripBase(pathname, baseUrl) {
  if (baseUrl && (pathname === baseUrl || pathname.startsWith(baseUrl + '/'))) {
    return pathname.slice(baseUrl.length) || '/';
  }
  return pathname;
}

export function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
