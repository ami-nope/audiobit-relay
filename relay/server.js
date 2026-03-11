'use strict';

const http = require('http');
const { URL } = require('url');
const WebSocket = require('ws');

const config = require('./config');
const SessionManager = require('./sessionManager');
const ActivityLog = require('./activityLog');
const { createSessionPairing } = require('./pairingService');
const { createProtocolValidator } = require('./protocolValidator');
const { createMessageRouter } = require('./messageRouter');
const { parseJsonBody, sendErrorResponse, sendJsonResponse } = require('./utils');

const sessionManager = new SessionManager({ sessionTtlMs: config.SESSION_TTL_MS });
const activityLog = new ActivityLog({ maxPerSession: 300, maxTotal: 5000 });
const validator = createProtocolValidator({ maxMessageBytes: config.MAX_MESSAGE_BYTES });
const messageRouter = createMessageRouter({ sessionManager, validator, activityLog });

function normalizeSidInput(value) {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return '';
}

function normalizePairCodeInput(value) {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value)).padStart(6, '0');
  }
  return '';
}

function handleCreateSession(req, res) {
  parseJsonBody(req, config.MAX_MESSAGE_BYTES)
    .then((body) => {
      const payload = body && typeof body === 'object' ? body : {};
      const requestedSid = normalizeSidInput(payload.sid);
      const requestedPairCode = normalizePairCodeInput(
        payload.pair_code !== undefined ? payload.pair_code : payload.code
      );

      const pairing = createSessionPairing(sessionManager, {
        sessionTtlMs: config.SESSION_TTL_MS,
        qrBaseUrl: config.QR_BASE_URL,
        requestedSid,
        requestedPairCode
      });

      sessionManager.createSession({
        sid: pairing.sid,
        pairCode: pairing.pair_code,
        createdAt: pairing.created_at,
        expiresAt: pairing.expires_at
      });

      activityLog.record({
        sid: pairing.sid,
        type: 'session_created',
        message: 'Session created.',
        detail: { expires_at: pairing.expires_at }
      });

      console.log(`[session created] sid=${pairing.sid} pair_code=${pairing.pair_code}`);
      sendJsonResponse(res, 201, {
        sid: pairing.sid,
        pair_code: pairing.pair_code,
        expires: pairing.expires_at,
        qr_url: pairing.qr_url
      });
    })
    .catch((error) => {
      const statusCode = String(error.message).includes('too large') ? 413 : 400;
      sendErrorResponse(res, statusCode, 'invalid_request', error.message);
    });
}

function sendHtmlResponse(res, statusCode, html) {
  if (res.writableEnded) {
    return;
  }

  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html)
  });
  res.end(html);
}

function buildCountSnapshot() {
  const sessions = sessionManager.getLiveSnapshot();
  let pcCount = 0;
  let remoteCount = 0;
  for (const session of sessions) {
    if (session.pc) {
      pcCount += 1;
    }
    if (Array.isArray(session.remotes)) {
      remoteCount += session.remotes.length;
    }
  }

  return {
    now: Date.now(),
    totals: {
      sessions: sessions.length,
      pc_connections: pcCount,
      remote_connections: remoteCount,
      total_connections: pcCount + remoteCount
    },
    sessions
  };
}

function renderCountPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Relay Live Count</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700&family=Space+Grotesk:wght@400;500;600&display=swap');
    :root {
      color-scheme: dark;
      --bg: #0b0c0f;
      --panel: #15171d;
      --panel-strong: #1b1f26;
      --silver: #c4c8cf;
      --silver-soft: #9ca2aa;
      --white: #f6f7f9;
      --border: #2b2f37;
      --accent: #e5e7eb;
      --shadow: rgba(0, 0, 0, 0.45);
      --radius: 70px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: 'Sora', 'Space Grotesk', sans-serif;
      background: radial-gradient(circle at 20% 20%, #1b1d23 0%, #0b0c0f 45%, #07080b 100%);
      color: var(--white);
    }
    .shell {
      position: relative;
      max-width: 1200px;
      margin: 40px auto 80px;
      padding: 28px;
      border-radius: var(--radius);
      background: linear-gradient(135deg, rgba(30, 34, 41, 0.96), rgba(16, 18, 23, 0.98));
      border: 1px solid var(--border);
      box-shadow: 0 30px 80px var(--shadow);
      overflow: hidden;
    }
    .shell::before {
      content: '';
      position: absolute;
      inset: -40% 35% auto -40%;
      height: 220px;
      background: radial-gradient(circle, rgba(255, 255, 255, 0.18), transparent 70%);
      opacity: 0.5;
      pointer-events: none;
    }
    header {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
    }
    h1 {
      margin: 0;
      font-size: 28px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .subtitle {
      color: var(--silver-soft);
      font-size: 14px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .stats {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }
    .stat-card {
      padding: 12px 18px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: rgba(20, 22, 27, 0.7);
      color: var(--silver);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 12px;
      letter-spacing: 0.1em;
    }
    .table-wrap {
      border-radius: var(--radius);
      border: 1px solid var(--border);
      background: rgba(12, 13, 17, 0.92);
      overflow: hidden;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    thead {
      background: rgba(26, 30, 37, 0.95);
    }
    th, td {
      padding: 14px 16px;
      text-align: left;
      font-size: 13px;
    }
    th {
      color: var(--silver-soft);
      text-transform: uppercase;
      letter-spacing: 0.12em;
      font-weight: 600;
    }
    tbody tr {
      background: rgba(16, 18, 23, 0.8);
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      transition: background 0.2s ease;
      cursor: pointer;
    }
    tbody tr:hover {
      background: rgba(35, 39, 47, 0.85);
    }
    tbody tr.active {
      background: rgba(62, 66, 76, 0.95);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
    }
    .role-pill {
      display: inline-block;
      padding: 6px 12px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.18);
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      font-size: 11px;
      color: var(--accent);
      background: rgba(255, 255, 255, 0.08);
    }
    .muted {
      color: var(--silver-soft);
    }
    .logs-panel {
      position: fixed;
      top: 40px;
      right: 32px;
      bottom: 40px;
      width: min(460px, 92vw);
      background: linear-gradient(150deg, rgba(26, 30, 36, 0.98), rgba(12, 14, 18, 0.98));
      border-radius: var(--radius);
      border: 1px solid var(--border);
      box-shadow: 0 30px 80px var(--shadow);
      padding: 24px;
      transform: translateX(120%);
      transition: transform 0.25s ease;
      z-index: 20;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .logs-panel.open {
      transform: translateX(0);
    }
    .logs-panel header {
      margin: 0;
    }
    .logs-panel h2 {
      margin: 0;
      font-size: 18px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .logs-panel button {
      background: transparent;
      color: var(--silver);
      border: 1px solid var(--border);
      padding: 8px 16px;
      border-radius: 999px;
      cursor: pointer;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-size: 11px;
    }
    .log-list {
      flex: 1;
      overflow-y: auto;
      display: grid;
      gap: 10px;
      padding-right: 4px;
    }
    .log-item {
      border-radius: 24px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      padding: 12px 14px;
      background: rgba(10, 11, 14, 0.75);
    }
    .log-meta {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: var(--silver-soft);
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    .log-detail {
      margin-top: 6px;
      font-size: 13px;
      color: var(--accent);
    }
    .backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease;
      z-index: 10;
    }
    .backdrop.show {
      opacity: 1;
      pointer-events: auto;
    }
    .footer {
      margin-top: 16px;
      font-size: 12px;
      color: var(--silver-soft);
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    @media (max-width: 900px) {
      .shell {
        margin: 20px 16px 60px;
        border-radius: 40px;
      }
      .logs-panel {
        right: 16px;
        left: 16px;
        width: auto;
        border-radius: 40px;
      }
      th, td {
        padding: 12px;
        font-size: 12px;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div>
        <div class="subtitle">Relay Monitor</div>
        <h1>Live Connection Count</h1>
      </div>
      <div class="stats">
        <div class="stat-card" id="stat-sessions">Sessions: 0</div>
        <div class="stat-card" id="stat-pc">PC: 0</div>
        <div class="stat-card" id="stat-remotes">Remotes: 0</div>
        <div class="stat-card" id="stat-total">Total: 0</div>
      </div>
    </header>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Session</th>
            <th>Role</th>
            <th>Device</th>
            <th>Connected For</th>
            <th>Connected At</th>
            <th>IP</th>
          </tr>
        </thead>
        <tbody id="connection-rows"></tbody>
      </table>
    </div>
    <div class="footer" id="last-updated">Last updated: --</div>
  </div>

  <div class="backdrop" id="backdrop"></div>
  <aside class="logs-panel" id="logs-panel">
    <header>
      <div>
        <div class="subtitle">Session Logs</div>
        <h2 id="logs-title">No session selected</h2>
      </div>
      <button id="close-logs" type="button">Close</button>
    </header>
    <div class="log-list" id="log-list"></div>
  </aside>

  <script>
    const rowsEl = document.getElementById('connection-rows');
    const statSessions = document.getElementById('stat-sessions');
    const statPc = document.getElementById('stat-pc');
    const statRemotes = document.getElementById('stat-remotes');
    const statTotal = document.getElementById('stat-total');
    const lastUpdated = document.getElementById('last-updated');
    const logsPanel = document.getElementById('logs-panel');
    const logsTitle = document.getElementById('logs-title');
    const logList = document.getElementById('log-list');
    const backdrop = document.getElementById('backdrop');
    const closeLogs = document.getElementById('close-logs');
    let selectedSid = null;

    function formatTime(ts) {
      if (!ts) return '--';
      const date = new Date(ts);
      return date.toLocaleString();
    }

    function formatDuration(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '--';
      const totalSeconds = Math.floor(ms / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      if (hours > 0) return hours + 'h ' + minutes + 'm ' + seconds + 's';
      if (minutes > 0) return minutes + 'm ' + seconds + 's';
      return seconds + 's';
    }

    function escapeHtml(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function buildRows(snapshot) {
      const now = snapshot.now;
      const rows = [];
      snapshot.sessions.forEach(function(session) {
        if (session.pc) {
          rows.push({
            sid: session.sid,
            role: 'PC',
            device: session.pc.device_name || 'PC',
            connected_at: session.pc.connected_at,
            ip: session.pc.ip || '--'
          });
        }
        (session.remotes || []).forEach(function(remote) {
          rows.push({
            sid: session.sid,
            role: 'Remote',
            device: remote.device_name || remote.device_id || 'Remote',
            connected_at: remote.connected_at,
            ip: remote.ip || '--'
          });
        });
      });

      rowsEl.innerHTML = rows.map(function(row) {
        const duration = formatDuration(now - (row.connected_at || now));
        return '<tr data-sid="' + escapeHtml(row.sid) + '">' +
          '<td>' + escapeHtml(row.sid) + '</td>' +
          '<td><span class="role-pill">' + escapeHtml(row.role) + '</span></td>' +
          '<td>' + escapeHtml(row.device) + '</td>' +
          '<td>' + escapeHtml(duration) + '</td>' +
          '<td class="muted">' + escapeHtml(formatTime(row.connected_at)) + '</td>' +
          '<td class="muted">' + escapeHtml(row.ip) + '</td>' +
          '</tr>';
      }).join('');
    }

    function updateStats(snapshot) {
      statSessions.textContent = 'Sessions: ' + snapshot.totals.sessions;
      statPc.textContent = 'PC: ' + snapshot.totals.pc_connections;
      statRemotes.textContent = 'Remotes: ' + snapshot.totals.remote_connections;
      statTotal.textContent = 'Total: ' + snapshot.totals.total_connections;
      lastUpdated.textContent = 'Last updated: ' + formatTime(snapshot.now);
    }

    async function refresh() {
      const res = await fetch('/count/data', { cache: 'no-store' });
      const snapshot = await res.json();
      updateStats(snapshot);
      buildRows(snapshot);
      if (selectedSid) {
        highlightSelected(selectedSid);
      }
    }

    function highlightSelected(sid) {
      document.querySelectorAll('tbody tr').forEach(function(row) {
        if (row.dataset.sid === sid) {
          row.classList.add('active');
        } else {
          row.classList.remove('active');
        }
      });
    }

    async function openLogs(sid) {
      selectedSid = sid;
      highlightSelected(sid);
      logsTitle.textContent = 'Session ' + sid;
      logsPanel.classList.add('open');
      backdrop.classList.add('show');

      const res = await fetch('/count/logs?sid=' + encodeURIComponent(sid), { cache: 'no-store' });
      const data = await res.json();
      if (!data.logs || data.logs.length === 0) {
        logList.innerHTML = '<div class="log-item">No logs yet.</div>';
        return;
      }

      logList.innerHTML = data.logs.map(function(entry) {
        const detail = entry.message || entry.type;
        const device = entry.device_name || entry.device_id || '';
        const deviceText = device ? ' • ' + escapeHtml(device) : '';
        return '<div class="log-item">' +
          '<div class="log-meta">' +
          '<span>' + escapeHtml(entry.type) + '</span>' +
          '<span>' + escapeHtml(formatTime(entry.ts)) + '</span>' +
          '</div>' +
          '<div class="log-detail">' + escapeHtml(detail) + deviceText + '</div>' +
          '</div>';
      }).join('');
    }

    function closeLogsPanel() {
      logsPanel.classList.remove('open');
      backdrop.classList.remove('show');
    }

    rowsEl.addEventListener('click', function(event) {
      const row = event.target.closest('tr[data-sid]');
      if (!row) return;
      openLogs(row.dataset.sid);
    });
    closeLogs.addEventListener('click', closeLogsPanel);
    backdrop.addEventListener('click', closeLogsPanel);

    refresh();
    setInterval(refresh, 2500);
  </script>
</body>
</html>`;
}

function routeHttpRequest(req, res) {
  if (!req.url) {
    sendErrorResponse(res, 400, 'bad_request', 'Missing request URL.');
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    sendJsonResponse(res, 204, {});
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/') {
    sendJsonResponse(res, 200, {
      service: 'AudioBit Remote Relay',
      now: Date.now(),
      endpoints: {
        create_session: { method: 'POST', path: '/create-session' },
        health: { method: 'GET', path: '/health' },
        ws: { method: 'GET (Upgrade)', path: config.WS_PATH },
        count: { method: 'GET', path: '/count' }
      }
    });
    return;
  }

  if (requestUrl.pathname === '/create-session') {
    if (req.method !== 'POST') {
      sendErrorResponse(res, 405, 'method_not_allowed', 'Use POST /create-session.');
      return;
    }
    handleCreateSession(req, res);
    return;
  }

  if (requestUrl.pathname === '/health') {
    if (req.method !== 'GET') {
      sendErrorResponse(res, 405, 'method_not_allowed', 'Use GET /health.');
      return;
    }
    sendJsonResponse(res, 200, {
      ok: true,
      sessions: sessionManager.getSessionCount(),
      now: Date.now()
    });
    return;
  }

  if (requestUrl.pathname === '/count') {
    if (req.method !== 'GET') {
      sendErrorResponse(res, 405, 'method_not_allowed', 'Use GET /count.');
      return;
    }
    sendHtmlResponse(res, 200, renderCountPage());
    return;
  }

  if (requestUrl.pathname === '/count/data') {
    if (req.method !== 'GET') {
      sendErrorResponse(res, 405, 'method_not_allowed', 'Use GET /count/data.');
      return;
    }
    sendJsonResponse(res, 200, buildCountSnapshot());
    return;
  }

  if (requestUrl.pathname === '/count/logs') {
    if (req.method !== 'GET') {
      sendErrorResponse(res, 405, 'method_not_allowed', 'Use GET /count/logs.');
      return;
    }
    const sid = requestUrl.searchParams.get('sid');
    if (!sid) {
      sendErrorResponse(res, 400, 'missing_sid', 'sid is required.');
      return;
    }
    const logs = activityLog.getBySid(sid, { limit: 300 });
    sendJsonResponse(res, 200, { sid, logs });
    return;
  }

  if (requestUrl.pathname === '/connect') {
    if (req.method !== 'GET') {
      sendErrorResponse(res, 405, 'method_not_allowed', 'Use GET /connect.');
      return;
    }
    sendJsonResponse(res, 200, {
      sid: requestUrl.searchParams.get('sid') || null,
      pair_code: requestUrl.searchParams.get('code') || null
    });
    return;
  }

  sendErrorResponse(res, 404, 'not_found', 'Route not found.');
}

const server = http.createServer(routeHttpRequest);

const wss = new WebSocket.Server({
  noServer: true,
  maxPayload: config.MAX_MESSAGE_BYTES,
  perMessageDeflate: {
    threshold: 256,
    clientNoContextTakeover: true,
    serverNoContextTakeover: true
  }
});

wss.on('connection', (ws, req) => {
  messageRouter.bindSocket(ws, req);
});

server.on('upgrade', (req, socket, head) => {
  if (!req.url) {
    socket.destroy();
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const validPath = requestUrl.pathname === config.WS_PATH || requestUrl.pathname === '/';
  if (!validPath) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

const heartbeat = setInterval(() => {
  sessionManager.cleanupExpiredSessions();

  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }

    ws.isAlive = false;
    try {
      ws.ping();
    } catch (_) {
      ws.terminate();
    }
  }
}, config.HEARTBEAT_INTERVAL_MS);

heartbeat.unref();

server.listen(config.PORT, () => {
  console.log(`[relay] listening on port ${config.PORT}`);
});

function shutdown(signal) {
  console.log(`[relay] received ${signal}, shutting down`);
  clearInterval(heartbeat);

  for (const ws of wss.clients) {
    ws.terminate();
  }

  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
