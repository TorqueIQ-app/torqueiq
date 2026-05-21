/**
 * TorqueIQ — Cloudflare Worker API Proxy
 *
 * Routes
 *   POST /api/chat  →  https://api.anthropic.com/v1/messages
 *
 * Secrets  (set via: wrangler secret put ANTHROPIC_API_KEY)
 *   ANTHROPIC_API_KEY
 *
 * Vars  (set in wrangler.toml [vars] or wrangler.toml [env.production.vars])
 *   ALLOWED_ORIGIN   e.g. "https://yourname.github.io"
 *
 * Bindings
 *   RATE_LIMITER     ratelimit — 10 req / 60 s per IP
 */

const ANTHROPIC_API  = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VER  = '2023-06-01';

// ─── CORS ────────────────────────────────────────────────────────────────────

/**
 * Decide which origin to echo back in Access-Control-Allow-Origin.
 * Allows: the configured ALLOWED_ORIGIN env var, plus localhost on any
 * port for local development.  Everything else gets a 403.
 */
function getAllowedOrigin(requestOrigin, env) {
  const configured = (env.ALLOWED_ORIGIN || '').trim();

  // Local dev — allow any localhost / 127.0.0.1 origin
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(requestOrigin)) {
    return requestOrigin;
  }

  // Local dev — file:// pages send the literal string "null" as Origin.
  // Allow it through so index.html can be opened directly from disk.
  if (requestOrigin === 'null') {
    return 'null';
  }

  // Configured production origin
  if (configured && requestOrigin === configured) {
    return requestOrigin;
  }

  // No match
  return null;
}

function corsHeaders(allowedOrigin) {
  return {
    'Access-Control-Allow-Origin':  allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function jsonResponse(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    // ── CORS origin check ──────────────────────────────────────────────────
    const allowedOrigin = getAllowedOrigin(origin, env);

    // Preflight — always respond even if origin is disallowed (browser needs it)
    if (request.method === 'OPTIONS') {
      if (!allowedOrigin) {
        return new Response('Forbidden', { status: 403 });
      }
      return new Response(null, {
        status: 204,
        headers: corsHeaders(allowedOrigin),
      });
    }

    if (!allowedOrigin) {
      return jsonResponse({ error: 'Origin not allowed' }, 403);
    }

    const cors = corsHeaders(allowedOrigin);

    // ── Route guard ────────────────────────────────────────────────────────
    if (url.pathname !== '/api/chat' || request.method !== 'POST') {
      return jsonResponse({ error: 'Not found' }, 404, cors);
    }

    // ── Rate limiting ──────────────────────────────────────────────────────
    // Uses the Workers Rate Limiting API binding (see wrangler.toml).
    // 10 requests per IP per 60-second window.
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await env.RATE_LIMITER.limit({ key: clientIP });
    if (!success) {
      return jsonResponse(
        { error: { message: 'Rate limit exceeded — try again in a minute' } },
        429,
        { ...cors, 'Retry-After': '60' },
      );
    }

    // ── Parse + sanitize request body ──────────────────────────────────────
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: { message: 'Invalid JSON body' } }, 400, cors);
    }

    // Strip any auth fields the client should never send
    const safeBody = { ...body };
    delete safeBody['x-api-key'];
    delete safeBody['anthropic-dangerous-direct-browser-access'];

    // Basic sanity check — must have messages array
    if (!Array.isArray(safeBody.messages) || safeBody.messages.length === 0) {
      return jsonResponse({ error: { message: 'messages array is required' } }, 400, cors);
    }

    // ── Forward to Anthropic ───────────────────────────────────────────────
    let upstream;
    try {
      upstream = await fetch(ANTHROPIC_API, {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         env.ANTHROPIC_API_KEY,
          'anthropic-version': ANTHROPIC_VER,
        },
        body: JSON.stringify(safeBody),
      });
    } catch (err) {
      return jsonResponse(
        { error: { message: 'Failed to reach Anthropic API' } },
        502,
        cors,
      );
    }

    // ── Stream-transparent proxy ───────────────────────────────────────────
    // Pipe the upstream body straight through unchanged.
    // Works for both standard JSON responses and streaming (text/event-stream).
    const responseHeaders = new Headers(cors);
    const contentType = upstream.headers.get('Content-Type');
    if (contentType) responseHeaders.set('Content-Type', contentType);

    return new Response(upstream.body, {
      status:  upstream.status,
      headers: responseHeaders,
    });
  },
};
