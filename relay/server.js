'use strict';

const http = require('http');
const { URL } = require('url');
const WebSocket = require('ws');

const config = require('./config');
const SessionManager = require('./sessionManager');
const { createSessionPairing } = require('./pairingService');
const { createProtocolValidator } = require('./protocolValidator');
const { createMessageRouter } = require('./messageRouter');
const { parseJsonBody, sendErrorResponse, sendJsonResponse } = require('./utils');

const sessionManager = new SessionManager({ sessionTtlMs: config.SESSION_TTL_MS });
const validator = createProtocolValidator({ maxMessageBytes: config.MAX_MESSAGE_BYTES });
const messageRouter = createMessageRouter({ sessionManager, validator });

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
        ws: { method: 'GET (Upgrade)', path: config.WS_PATH }
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
