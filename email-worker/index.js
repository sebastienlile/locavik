/**
 * Locavik Email Worker — Cloudflare Worker
 * Proxy sécurisé entre le frontend et l'API Resend.
 *
 * Déploiement :
 *   cd email-worker
 *   npx wrangler deploy
 *   npx wrangler secret put RESEND_API_KEY   ← coller la clé Resend
 */

const ALLOWED_ORIGINS = [
  'https://locavik.com',
  'https://www.locavik.com',
  'http://localhost:8743',
  'http://127.0.0.1:8743',
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

    const cors = {
      'Access-Control-Allow-Origin':  allowedOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Preflight CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400, cors);
    }

    const { to, toName, subject, html, bcc } = body;

    if (!to || !subject || !html) {
      return json({ error: 'Missing required fields: to, subject, html' }, 400, cors);
    }

    // Appel Resend
    const payload = {
      from:    'Locavik <noreply@locavik.com>',
      to:      [to],
      subject,
      html,
    };
    if (bcc) payload.bcc = [bcc];

    let resendRes;
    try {
      resendRes = await fetch('https://api.resend.com/emails', {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      return json({ error: 'Resend API unreachable', detail: err.message }, 502, cors);
    }

    const data = await resendRes.json();
    return json(data, resendRes.status, cors);
  },
};

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
