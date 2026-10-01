/**
 * @file        packages/coordinator/src/security.js
 * @description HTTP security headers for every response, and the same-origin check on the dashboard's state-changing requests (README §12)
 *
 * @author      Andrian Yablonskyy
 * @copyright   Copyright (c) 2026 Andrian Yablonskyy. All rights reserved.
 *
 * This file is part of TestHub and is proprietary and confidential.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without prior written permission
 * from AdSystem.PRO.
 */

'use strict';

// Everything the dashboard loads: its own files, plus Bootstrap and its
// icon font from jsDelivr (layout.pug). No inline script at all — the
// templates use data-* attributes (public/js/actions.js) — while inline
// style="" attributes, used throughout the templates, stay allowed.
const CDN = 'https://cdn.jsdelivr.net',
  CONTENT_SECURITY_POLICY = [
    'default-src \'self\'',
    `script-src 'self' ${CDN}`,
    `style-src 'self' ${CDN} 'unsafe-inline'`,
    `font-src 'self' ${CDN}`,
    // data: — Bootstrap's CSS draws some icons (select arrow, close button)
    // as inline SVG images.
    'img-src \'self\' data:',
    'connect-src \'self\'',
    'object-src \'none\'',
    'base-uri \'self\'',
    'form-action \'self\'',
    'frame-ancestors \'none\''
  ].join('; '),
  // 180 days, this host only: HTTPS is how a TLS-fronted Coordinator is
  // reached; other hosts under the same domain are none of its business.
  HSTS = 'max-age=15552000',
  UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Sent on every response (dashboard, API, static files).
function securityHeaders(req, res, next){
  res.set({
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    // Also frame-ancestors above; this one for browsers that predate it.
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    // Full URLs (job ids, searches) only within the dashboard itself.
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin'
  });
  // Only on HTTPS (behind a TLS proxy: X-Forwarded-Proto from a trusted
  // proxy, trustProxy) — over plain HTTP a browser ignores it anyway.
  if (req.secure){
    res.set('Strict-Transport-Security', HSTS);
  }
  next();
}

function originOf(url){
  try {
    return new URL(url).origin;
  }
  catch {
    return null;
  }
}

// CSRF defence for the session-authenticated routes (the dashboard, and
// /api/v1/admin), on top of the session cookie's SameSite=Lax: a request
// that changes something must come from this dashboard's own pages. The
// browser says where from in Origin (every modern browser sends it on a
// POST), else Referer; a request carrying neither isn't from a browser page
// (curl, a script) and couldn't have been forged by one, so it passes. The
// Agent/Client APIs use bearer tokens, which a browser never attaches by
// itself, and don't go through here.
function sameOriginOnly(config){
  return (req, res, next) => {
    if (!UNSAFE_METHODS.has(req.method)){
      return next();
    }
    const origin = req.get('origin'),
      from = origin !== undefined ? origin : req.get('referer') !== undefined ? originOf(req.get('referer')) : undefined;
    if (from === undefined){
      return next();
    }
    // The address the browser used (Host, as the reverse proxy passes it),
    // or the configured publicUrl (a proxy that rewrites Host) — read on
    // every request, since the dashboard can change it (§13.2).
    const configured = originOf(config.publicUrl),
      allowed = [configured, `${req.protocol}://${req.get('host')}`];
    if (from && allowed.includes(from)){
      return next();
    }
    const text = `Blocked: this request came from ${from || 'an unknown page'}, not from this dashboard (${configured}). ` +
      'Changes can only be made from the dashboard\'s own pages. If you opened the dashboard at a different address, ' +
      'set publicUrl to that address.';
    if (req.originalUrl.startsWith('/api/')){ // req.path is relative to the router's mount point
      return res.status(403).json({ error: text });
    }
    res.status(403).type('text/plain').send(text);
  };
}

module.exports = { securityHeaders, sameOriginOnly, CONTENT_SECURITY_POLICY };
