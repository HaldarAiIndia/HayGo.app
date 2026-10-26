
'use strict';

const SCOPES = [
  'https://www.googleapis.com/auth/firebase.messaging',
  'https://www.googleapis.com/auth/firebase.database',
  'https://www.googleapis.com/auth/userinfo.email'
].join(' ');

let tokenCache = { token: null, exp: 0 };
let signingKeyPromise = null;
const requestHits = new Map();

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function b64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function encodeJson(value) {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

function getServiceAccount(env) {
  if (!env.SERVICE_ACCOUNT_JSON) {
    throw new Error('SERVICE_ACCOUNT_JSON Secret is missing.');
  }

  let sa;
  try {
    sa = JSON.parse(env.SERVICE_ACCOUNT_JSON);
  } catch {
    throw new Error('SERVICE_ACCOUNT_JSON is not valid JSON.');
  }

  for (const key of ['client_email', 'private_key', 'project_id']) {
    if (!sa[key]) {
      throw new Error('Service account is missing ' + key + '.');
    }
  }

  return sa;
}

function getSigningKey(sa) {
  if (!signingKeyPromise) {
    const pem = sa.private_key
      .replace(/-----BEGIN PRIVATE KEY-----/g, '')
      .replace(/-----END PRIVATE KEY-----/g, '')
      .replace(/\s/g, '');

    const binary = atob(pem);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));

    signingKeyPromise = crypto.subtle.importKey(
      'pkcs8',
      bytes,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    ).catch(error => {
      signingKeyPromise = null;
      throw error;
    });
  }

  return signingKeyPromise;
}

async function accessToken(env, sa) {
  const now = Math.floor(Date.now() / 1000);

  if (tokenCache.token && now < tokenCache.exp - 120) {
    return tokenCache.token;
  }

  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';

  const header = encodeJson({
    alg: 'RS256',
    typ: 'JWT',
    ...(sa.private_key_id ? { kid: sa.private_key_id } : {})
  });

  const claims = encodeJson({
    iss: sa.client_email,
    scope: SCOPES,
    aud: tokenUri,
    iat: now,
    exp: now + 3600
  });

  const unsigned = header + '.' + claims;
  const key = await getSigningKey(sa);

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned)
  );

  const assertion = unsigned + '.' + b64url(new Uint8Array(signature));

  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.access_token) {
    throw new HttpError(
      502,
      'Google sign-in failed: ' +
      (result.error_description || result.error || response.status)
    );
  }

  tokenCache = {
    token: result.access_token,
    exp: now + (result.expires_in || 3600)
  };

  return tokenCache.token;
}

function cleanString(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function isHttpUrl(value) {
  return typeof value === 'string' &&
    /^https?:\/\/[^\s]+$/i.test(value);
}

async function readJson(request) {
  const length = Number(request.headers.get('content-length') || 0);

  if (length > 65536) {
    throw new HttpError(413, 'Request too large.');
  }

  const text = await request.text();

  if (new TextEncoder().encode(text).length > 65536) {
    throw new HttpError(413, 'Request too large.');
  }

  if (!text) return {};

  try {
    const result = JSON.parse(text);

    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('Expected an object.');
    }

    return result;
  } catch {
    throw new HttpError(400, 'Body must be a JSON object.');
  }
}

async function authorized(request, env) {
  const expected = env.ADMIN_TOKEN || '';
  const auth = request.headers.get('authorization') || '';
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';

  if (!expected || expected.length < 16 || !given) return false;

  const encoder = new TextEncoder();
  const a = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(given))
  );
  const b = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(expected))
  );

  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a[i] ^ b[i];
  }

  return difference === 0;
}

function isRateLimited(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();
  const recent = (requestHits.get(ip) || [])
    .filter(time => now - time < 60000);

  recent.push(now);
  requestHits.set(ip, recent);

  if (requestHits.size > 1000) {
    for (const [key, times] of requestHits) {
      if (!times.some(time => now - time < 60000)) {
        requestHits.delete(key);
      }
    }
  }

  return recent.length > 60;
}

function jsonResponse(data, status, env, request) {
  const origin = env.ALLOWED_ORIGIN || '*';
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Vary': 'Origin'
  };

  if (origin !== '*') {
    const incoming = request.headers.get('Origin');
    if (incoming && incoming !== origin) {
      headers['Access-Control-Allow-Origin'] = origin;
    }
  }

  return new Response(
    status === 204 ? null : JSON.stringify(data),
    { status, headers }
  );
}

function getDbUrl(env, projectId) {
  return (
    env.DATABASE_URL ||
    `https://${projectId}-default-rtdb.asia-southeast1.firebasedatabase.app`
  ).replace(/\/+$/, '');
}

function getHistoryNode(env) {
  return (env.HISTORY_NODE || 'notification_history')
    .replace(/^\/+|\/+$/g, '');
}

async function dbCall(env, sa, projectId, method, path, body) {
  const dbUrl = getDbUrl(env, projectId);
  const safePath = path.split('/').map(encodeURIComponent).join('/');
  const token = await accessToken(env, sa);

  const response = await fetch(
    `${dbUrl}/${safePath}.json`,
    {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }
  );

  const result = await response.json().catch(() => null);

  if (!response.ok) {
    throw new HttpError(
      502,
      'Database error: ' + ((result && result.error) || response.status)
    );
  }

  return result;
}

function cleanMessage(body) {
  const title = cleanString(body.title, 200);
  const messageBody = cleanString(body.body, 1000);
  const url = cleanString(body.url, 2000);
  const icon = cleanString(body.icon, 2000);
  const tag = cleanString(body.tag, 100);

  if (!messageBody) {
    throw new HttpError(400, 'A message ("body") is required.');
  }

  if (url && !isHttpUrl(url)) {
    throw new HttpError(400, '"url" must start with http:// or https://');
  }

  if (icon && !isHttpUrl(icon)) {
    throw new HttpError(400, '"icon" must start with http:// or https://');
  }

  const random = crypto.getRandomValues(new Uint8Array(4));
  const id = Date.now().toString(36) + b64url(random);

  const entry = { id, body: messageBody };

  if (title) entry.title = title;
  if (url) entry.url = url;
  if (icon) entry.icon = icon;
  if (tag) entry.tag = tag;

  return entry;
}

function getTarget(body, env) {
  const target = body.target || {};
  const defaultTopic = env.DEFAULT_TOPIC || 'all';

  if (target.type === 'token') {
    const token = cleanString(target.value, 4096);
    if (token.length < 20) {
      throw new HttpError(400, 'Enter a valid device token.');
    }
    return { token };
  }

  if (target.type === 'topic') {
    const topic = cleanString(target.value, 200);

    if (!/^[a-zA-Z0-9-_.~%]{1,200}$/.test(topic)) {
      throw new HttpError(
        400,
        'Topic names may only use letters, numbers and - _ . ~ %'
      );
    }

    return { topic };
  }

  return { topic: defaultTopic };
}

async function fcmSend(env, sa, projectId, target, data) {
  const message = {
    data,
    android: {
      priority: 'HIGH',
      ttl: '86400s'
    }
  };

  if (target.token) message.token = target.token;
  else message.topic = target.topic || env.DEFAULT_TOPIC || 'all';

  const base = (env.FCM_BASE_URL || 'https://fcm.googleapis.com')
    .replace(/\/+$/, '');

  const response = await fetch(
    `${base}/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + await accessToken(env, sa),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ message })
    }
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = result.error || {};
    const details = error.details || [];
    const code =
      (details.find(item => item.errorCode) || {}).errorCode ||
      error.status ||
      response.status;

    const hint = code === 'UNREGISTERED'
      ? 'That device token is no longer valid.'
      : code === 'INVALID_ARGUMENT'
      ? 'FCM rejected the message: ' + (error.message || '')
      : code === 'PERMISSION_DENIED'
      ? 'Check Firebase Cloud Messaging API and service-account permissions.'
      : (error.message || 'FCM error');

    throw new HttpError(response.status === 404 ? 404 : 502, hint, { code });
  }

  return result.name;
}

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return jsonResponse({}, 204, env, request);
  }

  if (url.pathname === '/' || url.pathname === '/health') {
    try {
      const sa = getServiceAccount(env);
      return jsonResponse({
        ok: true,
        service: 'haygo-push-backend',
        project: sa.project_id
      }, 200, env, request);
    } catch (error) {
      return jsonResponse({
        ok: false,
        error: 'Backend configuration is incomplete.'
      }, 500, env, request);
    }
  }

  if (!url.pathname.startsWith('/api/')) {
    return jsonResponse({ error: 'Not found' }, 404, env, request);
  }

  if (isRateLimited(request)) {
    return jsonResponse(
      { error: 'Too many requests. Slow down.' },
      429, env, request
    );
  }

  if (!(await authorized(request, env))) {
    return jsonResponse(
      { error: 'Wrong or missing admin token.' },
      401, env, request
    );
  }

  try {
    const sa = getServiceAccount(env);
    const projectId = sa.project_id;
    const node = getHistoryNode(env);

    if (request.method === 'GET' && url.pathname === '/api/ping') {
      return jsonResponse({
        ok: true,
        project: projectId,
        topic: env.DEFAULT_TOPIC || 'all'
      }, 200, env, request);
    }

    if (request.method === 'POST' && url.pathname === '/api/send') {
      const body = await readJson(request);
      const entry = cleanMessage(body);
      const target = getTarget(body, env);
      const data = {};

      for (const key of ['id', 'title', 'body', 'url', 'icon', 'tag']) {
        if (entry[key]) data[key] = String(entry[key]);
      }

      const messageName = await fcmSend(
        env, sa, projectId, target, data
      );

      let historyKey = null;

      if (body.saveHistory !== false) {
        try {
          const saved = await dbCall(
            env, sa, projectId, 'POST', node,
            { ...entry, createdAt: { '.sv': 'timestamp' } }
          );
          historyKey = saved && saved.name;
        } catch (error) {
          console.error('History save failed:', error.message);
        }
      }

      return jsonResponse({
        ok: true,
        id: entry.id,
        message: messageName,
        historyKey
      }, 200, env, request);
    }

    if (url.pathname === '/api/history' && request.method === 'DELETE') {
      await dbCall(env, sa, projectId, 'DELETE', node);
      return jsonResponse({ ok: true }, 200, env, request);
    }

    const match = url.pathname.match(/^\/api\/history\/([^/]+)$/);

    if (match) {
      const key = decodeURIComponent(match[1]);

      if (!/^[-A-Za-z0-9_]{1,64}$/.test(key)) {
        throw new HttpError(400, 'Bad key');
      }

      if (request.method === 'DELETE') {
        await dbCall(
          env, sa, projectId, 'DELETE', node + '/' + key
        );
        return jsonResponse({ ok: true }, 200, env, request);
      }

      if (request.method === 'PUT') {
        const body = await readJson(request);

        if (typeof body.body !== 'string') {
          throw new HttpError(400, 'Entry needs a "body".');
        }

        await dbCall(
          env, sa, projectId, 'PUT', node + '/' + key, body
        );

        return jsonResponse({ ok: true }, 200, env, request);
      }
    }

    return jsonResponse({ error: 'Not found' }, 404, env, request);

  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;

    if (status >= 500) {
      console.error('HayGo backend error:', error.message);
    }

    return jsonResponse({
      error: error instanceof HttpError
        ? error.message
        : 'Server error',
      ...(error instanceof HttpError ? error.extra : {})
    }, status, env, request);
  }
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  }
};
