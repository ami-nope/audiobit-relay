'use strict';

const crypto = require('crypto');

function createSessionId() {
  return crypto.randomBytes(12).toString('hex');
}

function createPairCode() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function isWsOpen(ws) {
  return Boolean(ws && ws.readyState === 1);
}

function closeWs(ws, code = 1000, reason = '') {
  if (!ws) {
    return;
  }

  try {
    if (ws.readyState === 0 || ws.readyState === 1) {
      ws.close(code, reason.slice(0, 123));
      return;
    }
    if (ws.readyState === 2) {
      ws.terminate();
    }
  } catch (_) {
    // Ignore transport-level close errors.
  }
}

function sendWsJson(ws, payload) {
  if (!isWsOpen(ws)) {
    return false;
  }
  ws.send(JSON.stringify(payload));
  return true;
}

function setCommonResponseHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJsonResponse(res, statusCode, payload) {
  if (res.writableEnded) {
    return;
  }

  setCommonResponseHeaders(res);
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendErrorResponse(res, statusCode, code, message) {
  sendJsonResponse(res, statusCode, {
    error: {
      code,
      message
    }
  });
}

function parseJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) {
        return;
      }

      received += chunk.length;
      if (received > maxBytes) {
        aborted = true;
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) {
        return;
      }

      if (chunks.length === 0) {
        resolve({});
        return;
      }

      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(text));
      } catch (_) {
        reject(new Error('Request body must be valid JSON.'));
      }
    });

    req.on('error', (error) => {
      if (!aborted) {
        reject(error);
      }
    });
  });
}

module.exports = {
  closeWs,
  createPairCode,
  createSessionId,
  isWsOpen,
  parseJsonBody,
  sendErrorResponse,
  sendJsonResponse,
  sendWsJson
};
