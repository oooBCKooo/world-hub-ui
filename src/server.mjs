import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { debugPageHtml } from './debug/page.mjs';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
const STATIC = new Map([
  ['/manage', 'management/console.html'], ['/manage/', 'management/console.html'], ['/manage/index.html', 'management/console.html'],
  ...['canvas-i18n.mjs', 'canvas-modes.mjs', 'launcher-link.mjs', 'manual-bridge.mjs', 'manual-console.mjs', 'manual-console.css', 'manual-experience-state.mjs', 'manual-i18n.mjs', 'resource-console.mjs'].map(name => [`/manage/${name}`, `management/${name}`]),
  ['/ui/language.mjs', 'ui/language.mjs'],
]);
const MIME = file => file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
const problem = (status, code, message) => Object.assign(new Error(message), { status, code });

export function validateHubURL(value) {
  let target;
  try { target = new URL(value); } catch { throw problem(400, 'HUB_URL_INVALID', 'Use an explicit local Hub HTTP origin.'); }
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
    || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
    throw problem(400, 'HUB_URL_INVALID', 'Only an HTTP loopback Hub origin without credentials, a path, or query is accepted.');
  }
  // Pin localhost to the IPv4 loopback; DNS cannot redirect this proxy elsewhere.
  if (target.hostname === 'localhost') target.hostname = '127.0.0.1';
  return target;
}

function bridgePathOf(value) {
  if (typeof value !== 'string' || !/^\/[a-zA-Z0-9._~/-]{1,255}$/.test(value) || value.includes('//')
    || value.split('/').some(segment => segment === '.' || segment === '..') || value.startsWith('/manage') || ['/status', '/log', '/health'].includes(value)) {
    throw problem(400, 'BRIDGE_PATH_INVALID', 'Use the Hub WebSocket transport path.');
  }
  return value;
}

function filteredHeaders(headers) {
  const blocked = new Set(HOP);
  for (const name of String(headers.connection ?? '').split(',')) blocked.add(name.trim().toLowerCase());
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !blocked.has(name.toLowerCase()) && name.toLowerCase() !== 'forwarded' && !name.toLowerCase().startsWith('x-forwarded-')) result[name] = value;
  }
  return result;
}

export async function createUIServer({ hub, port = 0, bridgePath, timeoutMs = 300000 } = {}) {
  const target = validateHubURL(hub);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw problem(400, 'PORT_INVALID', 'UI port must be between 0 and 65535.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw problem(400, 'TIMEOUT_INVALID', 'Proxy timeout must be between 100 and 300000 milliseconds.');
  let path;
  if (bridgePath !== undefined) path = bridgePathOf(bridgePath);
  else {
    // Discovery is read-only and bounded. A UI can start before a stopped Hub;
    // an unusual transport path should then be supplied explicitly.
    try {
      const response = await fetch(new URL('/manage/api/state', target), { redirect: 'error', signal: AbortSignal.timeout(2500) });
      if (response.ok) {
        const declared = Number(response.headers.get('content-length'));
        if (declared > 8 * 1024 * 1024) throw new Error('Oversized Hub state');
        let bytes = 0; const chunks = [];
        for await (const chunk of response.body) { bytes += chunk.byteLength; if (bytes > 8 * 1024 * 1024) throw new Error('Oversized Hub state'); chunks.push(chunk); }
        path = bridgePathOf(JSON.parse(Buffer.concat(chunks).toString('utf8')).transport?.path);
      }
    } catch { /* An unavailable Hub does not prevent the independent UI opening. */ }
    path ??= '/bridge';
  }
  let origin, policy, closing;
  const sockets = new Set(), upstreams = new Set();
  function send(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(value));
  }
  function access(req) {
    if (!LOOPBACK.has(req.socket.remoteAddress)) throw problem(403, 'LOCAL_ONLY', 'The UI accepts loopback clients only.');
    if (req.headers.host !== new URL(origin).host) throw problem(403, 'HOST_REJECTED', 'Use the exact UI address printed by its terminal.');
    if (req.headers.origin !== undefined && req.headers.origin !== origin) throw problem(403, 'ORIGIN_REJECTED', 'Only this UI origin is accepted.');
    const entry = req.method === 'GET' && ['/','/manage','/manage/','/debug'].includes(req.url)
      && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document' && !req.headers.origin;
    if (['cross-site','same-site'].includes(req.headers['sec-fetch-site']) && !entry) throw problem(403, 'ORIGIN_REJECTED', 'Requests from another website or local service are rejected.');
    if (typeof req.url !== 'string' || req.url.length > 8192 || !req.url.startsWith('/') || req.url.startsWith('//')
      || /[\\\u0000-\u0020]|%(?:2f|5c|00|2e)/i.test(req.url) || req.url.split('?')[0].split('/').some(segment => segment === '.' || segment === '..')) {
      throw problem(400, 'PATH_REJECTED', 'Invalid UI request target.');
    }
    const url = new URL(req.url, origin);
    if (url.origin !== origin) throw problem(400, 'PATH_REJECTED', 'Invalid UI request origin.');
    return url;
  }
  function upstreamHeaders(req, upgrade = false) {
    const headers = filteredHeaders(req.headers);
    headers.host = target.host;
    // The validated local proxy is the same-origin caller of this fixed Hub.
    if (req.headers.origin || req.method === 'POST') headers.origin = target.origin;
    if (req.headers['sec-fetch-site']) headers['sec-fetch-site'] = 'same-origin';
    if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
    return headers;
  }
  const server = createServer({ maxHeaderSize: 16384 }, async (req, res) => {
    try {
      const url = access(req);
      if (!['GET','HEAD','POST'].includes(req.method)) throw problem(405, 'METHOD_NOT_ALLOWED', 'Use GET, HEAD, or POST.');
      if (req.method === 'GET' && url.pathname === '/') { res.writeHead(302, { location: '/manage/', 'cache-control': 'no-store' }); res.end(); return; }
      if (req.method === 'GET' && url.pathname === '/health') { send(res, 200, { ok: true, service: 'world-hub-ui', hub: target.origin, bridgePath: path }); return; }
      if (['GET','HEAD'].includes(req.method) && STATIC.has(url.pathname)) {
        const file = STATIC.get(url.pathname), bytes = await readFile(new URL('./' + file, import.meta.url));
        res.writeHead(200, { 'content-type': MIME(file), 'content-length': bytes.byteLength, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': policy });
        res.end(req.method === 'HEAD' ? undefined : bytes); return;
      }
      if (req.method === 'GET' && url.pathname === '/debug') {
        const bytes = Buffer.from(debugPageHtml({ hubId: 'World Hub', wireVersion: '0.1' }));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': policy }); res.end(bytes); return;
      }
      if (!['GET','POST'].includes(req.method) || !(/^\/manage\/api\/[A-Za-z0-9._/-]+$/.test(url.pathname) || ['/status','/log'].includes(url.pathname))) throw problem(404, 'NOT_FOUND', 'UI route not found.');
      if (req.method === 'POST' && !url.pathname.startsWith('/manage/api/')) throw problem(405, 'METHOD_NOT_ALLOWED', 'Diagnostic endpoints are read-only.');
      const proxy = httpRequest({ hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || 80, method: req.method, path: url.pathname + url.search, headers: upstreamHeaders(req), timeout: timeoutMs }, upstream => {
        // Location is not followed, and the browser never receives a redirect
        // that could move privileged API traffic to a different origin.
        if (upstream.statusCode >= 300 && upstream.statusCode < 400) { upstream.resume(); send(res, 502, { error: { code: 'UPSTREAM_REDIRECT_REJECTED', message: 'The configured Hub returned an unexpected redirect.' } }); return; }
        const headers = filteredHeaders(upstream.headers); delete headers['set-cookie']; headers['cache-control'] = 'no-store';
        res.writeHead(upstream.statusCode, headers); upstream.on('error', () => res.destroy()); upstream.pipe(res);
      });
      upstreams.add(proxy); proxy.once('close', () => upstreams.delete(proxy));
      proxy.on('timeout', () => proxy.destroy(new Error('Upstream timeout')));
      proxy.on('error', () => { if (res.headersSent) res.destroy(); else send(res, 502, { error: { code: 'HUB_UNAVAILABLE', message: 'The configured Hub is unavailable. Start it separately and refresh.' } }); });
      req.on('aborted', () => proxy.destroy()); req.on('error', () => proxy.destroy());
      res.on('close', () => { if (!res.writableFinished) proxy.destroy(); });
      req.pipe(proxy);
    } catch (error) { if (!res.headersSent) send(res, error.status ?? 500, { error: { code: error.code ?? 'UI_FAILED', message: error.status ? error.message : 'UI request failed.' } }); else res.destroy(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = access(req);
      if (req.method !== 'GET' || url.pathname !== path || url.search || req.headers.upgrade?.toLowerCase() !== 'websocket') throw problem(404, 'NOT_FOUND', 'WebSocket route not found.');
    } catch (error) { socket.end(`HTTP/1.1 ${error.status ?? 400} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return; }
    const proxy = httpRequest({ hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || 80, method: 'GET', path, headers: upstreamHeaders(req, true), timeout: Math.min(timeoutMs, 15000) });
    upstreams.add(proxy); proxy.once('close', () => upstreams.delete(proxy));
    proxy.on('upgrade', (res, upstream, upstreamHead) => {
      upstream.setTimeout(0);
      sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream));
      const headers = filteredHeaders(res.headers); headers.connection = 'Upgrade'; headers.upgrade = 'websocket';
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(headers).map(([key,value]) => `${key}: ${value}\r\n`).join('') + '\r\n');
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstream.write(head);
      upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
      socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
      socket.pipe(upstream); upstream.pipe(socket);
    });
    proxy.on('response', response => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode} Upstream Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); });
    proxy.on('timeout', () => proxy.destroy());
    proxy.on('error', () => { if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
    socket.once('close', () => proxy.destroy()); proxy.end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  // Some browsers do not map connect-src 'self' from HTTP to WebSocket.
  policy = CSP.replace("connect-src 'self'", `connect-src 'self' ${origin.replace('http:', 'ws:')}`);
  return { server, url: `${origin}/manage/`, origin, hub: target.origin, bridgePath: path,
    close() { return closing ??= new Promise(resolve => { for (const request of upstreams) request.destroy(); for (const socket of sockets) socket.destroy(); server.close(resolve); }); } };
}
