// Minimal cookie parse/serialize helpers. Express doesn't expose a public
// "parse an incoming Cookie header" function, and pulling in the `cookie`
// package for this alone (a handful of session/auth cookies) isn't worth a
// new dependency.

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

function serializeCookie(name, value, opts = {}) {
  let str = `${name}=${encodeURIComponent(value)}`;
  if (opts.maxAge !== undefined) str += `; Max-Age=${Math.floor(opts.maxAge)}`;
  str += `; Path=${opts.path || '/'}`;
  if (opts.httpOnly !== false) str += '; HttpOnly';
  str += `; SameSite=${opts.sameSite || 'Lax'}`;
  if (opts.secure) str += '; Secure';
  return str;
}

export { parseCookies, serializeCookie };
