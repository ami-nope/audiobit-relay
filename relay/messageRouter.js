'use strict';

const crypto = require('crypto');
const { closeWs, isWsOpen, sendWsJson } = require('./utils');

const POLICY_VIOLATION_CLOSE = 1008;
const REMOTE_LATENCY_PING_INTERVAL_MS = 4000;

function sanitizeString(value, maxLength = 160) {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.slice(0, maxLength);
}

function createMessageRouter({ sessionManager, validator }) {
  const remoteProbeTimers = new WeakMap();
  const remoteProbeState = new WeakMap();

  function extractConnectionInfo(req) {
    if (!req) {
      return {
        connection_type: 'websocket',
        ip: null,
        user_agent: null
      };
    }

    const forwardedFor = req.headers && typeof req.headers['x-forwarded-for'] === 'string'
      ? req.headers['x-forwarded-for'].split(',')[0].trim()
      : '';

    const socketIp = req.socket && typeof req.socket.remoteAddress === 'string'
      ? req.socket.remoteAddress.trim()
      : '';

    return {
      connection_type: 'websocket',
      ip: sanitizeString(forwardedFor || socketIp, 128) || null,
      user_agent: sanitizeString(req.headers && req.headers['user-agent'], 256) || null
    };
  }

  function buildRemoteIdentity(ws, message) {
    const connectionInfo = ws.connection_info || {};
    const providedDeviceId = sanitizeString(message.device_id, 128);
    const fingerprintSeed = [
      sanitizeString(message.device_name || message.name, 128),
      sanitizeString(connectionInfo.ip, 128),
      sanitizeString(connectionInfo.user_agent, 256)
    ].join('|');
    const derivedDeviceId = fingerprintSeed.replace(/\|/g, '').trim()
      ? `auto_${crypto.createHash('sha1').update(fingerprintSeed).digest('hex').slice(0, 20)}`
      : '';

    return {
      device_id: providedDeviceId || derivedDeviceId || null,
      device_name: message.device_name || message.name,
      device_location: message.device_location || message.location,
      connection_type: message.connection_type || connectionInfo.connection_type || 'websocket',
      ip: connectionInfo.ip || null,
      user_agent: connectionInfo.user_agent || null
    };
  }

  function buildDevicePayload(messageType, sid, remoteMeta, extra = {}) {
    return {
      t: messageType,
      sid,
      device_id: remoteMeta.device_id || null,
      device_name: remoteMeta.device_name || null,
      device_location: remoteMeta.device_location || null,
      connection_type: remoteMeta.connection_type || 'websocket',
      ip: remoteMeta.ip || null,
      user_agent: remoteMeta.user_agent || null,
      ...extra
    };
  }

  function stopRemoteLatencyProbe(remoteWs) {
    const timer = remoteProbeTimers.get(remoteWs);
    if (timer) {
      clearInterval(timer);
      remoteProbeTimers.delete(remoteWs);
    }
    remoteProbeState.delete(remoteWs);
  }

  function startRemoteLatencyProbe(remoteWs) {
    stopRemoteLatencyProbe(remoteWs);

    const sendProbe = () => {
      if (!isWsOpen(remoteWs)) {
        stopRemoteLatencyProbe(remoteWs);
        return;
      }

      const ts = Date.now();
      remoteProbeState.set(remoteWs, { ts });
      sendWsJson(remoteWs, { t: 'ping', ts, source: 'relay_latency' });
    };

    sendProbe();
    const timer = setInterval(sendProbe, REMOTE_LATENCY_PING_INTERVAL_MS);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    remoteProbeTimers.set(remoteWs, timer);
  }

  function handleLatencyPong(ws, message) {
    const meta = sessionManager.getSocketMeta(ws);
    if (!meta || meta.role !== 'remote') {
      return;
    }

    const session = sessionManager.getSession(meta.sid);
    if (!session || !isWsOpen(session.pc_conn)) {
      return;
    }

    const pendingProbe = remoteProbeState.get(ws);
    const echoedTs = Number.isFinite(message.ts)
      ? message.ts
      : pendingProbe && Number.isFinite(pendingProbe.ts)
        ? pendingProbe.ts
        : null;

    if (!Number.isFinite(echoedTs)) {
      return;
    }

    const now = Date.now();
    const latencyMs = Math.max(0, now - echoedTs);
    sendWsJson(
      session.pc_conn,
      buildDevicePayload('device_latency', meta.sid, meta, {
        ts: echoedTs,
        rtt_ms: latencyMs,
        measured_at: now
      })
    );

    if (pendingProbe && pendingProbe.ts === echoedTs) {
      remoteProbeState.delete(ws);
    }
  }

  function sendProtocolError(ws, code, message) {
    sendWsJson(ws, {
      t: 'err',
      code,
      message
    });
  }

  function broadcastRawToRemotes(session, rawMessage) {
    const stale = [];
    for (const remoteWs of session.remote_conns) {
      if (!isWsOpen(remoteWs)) {
        stale.push(remoteWs);
        continue;
      }
      remoteWs.send(rawMessage);
    }

    for (const ws of stale) {
      stopRemoteLatencyProbe(ws);
      sessionManager.removeSocket(ws);
    }
  }

  function handleHelloPc(ws, message) {
    const result = sessionManager.registerPc(message.sid, ws);
    if (!result.ok) {
      sendProtocolError(ws, result.code, result.message);
      closeWs(ws, POLICY_VIOLATION_CLOSE, result.message);
      return;
    }

    const session = result.session;
    sendWsJson(ws, {
      t: 'hello_ok',
      role: 'pc',
      sid: message.sid
    });

    broadcastRawToRemotes(session, JSON.stringify({ t: 'session_status', pc_online: 1 }));

    for (const remoteWs of session.remote_conns) {
      const remoteMeta = sessionManager.getSocketMeta(remoteWs);
      if (!remoteMeta || remoteMeta.role !== 'remote') {
        continue;
      }

      sendWsJson(ws, buildDevicePayload('device_connected', message.sid, remoteMeta));
    }

    console.log(`[PC connected] sid=${message.sid}`);
  }

  function handleHelloRemote(ws, message) {
    const remoteIdentity = buildRemoteIdentity(ws, message);
    const result = sessionManager.registerRemote(message.sid, message.pair_code, ws, remoteIdentity);
    if (!result.ok) {
      sendProtocolError(ws, result.code, result.message);
      closeWs(ws, POLICY_VIOLATION_CLOSE, result.message);
      return;
    }

    const session = result.session;
    const remoteMeta = result.remoteMeta || sessionManager.getSocketMeta(ws);
    sendWsJson(ws, {
      t: 'hello_ok',
      role: 'remote',
      sid: message.sid
    });
    sendWsJson(ws, {
      t: 'session_status',
      pc_online: session.pc_conn ? 1 : 0
    });

    const cachedState = sessionManager.getCachedStateRaw(message.sid);
    if (cachedState && isWsOpen(ws)) {
      ws.send(cachedState);
    }

    startRemoteLatencyProbe(ws);

    if (isWsOpen(session.pc_conn) && remoteMeta) {
      const connectedCount = session.remote_conns.size;
      const existingDeviceCount = Math.max(0, connectedCount - 1);
      const extra =
        existingDeviceCount > 0
          ? { existing_device_count: existingDeviceCount, connected_device_count: connectedCount }
          : {};
      sendWsJson(session.pc_conn, buildDevicePayload('device_connected', message.sid, remoteMeta, extra));
    }

    const deviceLabel = remoteMeta && remoteMeta.device_id ? remoteMeta.device_id : 'n/a';
    console.log(`[remote connected] sid=${message.sid} remotes=${session.remote_conns.size} device_id=${deviceLabel}`);
  }

  function handleRemoteMessage(ws, sid, session, message, rawMessage) {
    if (message.t === 'cmd') {
      if (!isWsOpen(session.pc_conn)) {
        sendWsJson(ws, { t: 'session_status', pc_online: 0 });
        sendProtocolError(ws, 'pc_offline', 'PC is not connected.');
        return;
      }

      session.pc_conn.send(rawMessage);
      console.log(`[command forwarded] sid=${sid}`);
      return;
    }

    if (message.t === 'resync') {
      const cachedState = sessionManager.getCachedStateRaw(sid);
      if (cachedState && isWsOpen(ws)) {
        ws.send(cachedState);
      }
      return;
    }

    sendProtocolError(ws, 'role_violation', `Remote cannot send type "${message.t}".`);
  }

  function handlePcRemoveDevice(sid, session, message) {
    const targetRemoteWs = sessionManager.findRemoteSocket(sid, message.device_id);
    if (!targetRemoteWs) {
      sendProtocolError(session.pc_conn, 'device_not_found', 'No matching connected device was found.');
      return;
    }

    const targetMeta = sessionManager.getSocketMeta(targetRemoteWs);
    if (!targetMeta || targetMeta.role !== 'remote') {
      sendProtocolError(session.pc_conn, 'device_not_found', 'No matching connected device was found.');
      return;
    }

    stopRemoteLatencyProbe(targetRemoteWs);
    sessionManager.removeSocket(targetRemoteWs);
    sendWsJson(targetRemoteWs, buildDevicePayload('device_removed', sid, targetMeta, { removed_by: 'pc' }));
    closeWs(targetRemoteWs, 4003, 'removed_by_pc');

    if (isWsOpen(session.pc_conn)) {
      sendWsJson(session.pc_conn, buildDevicePayload('device_removed', sid, targetMeta, { removed_by: 'pc' }));
    }

    console.log(`[device removed] sid=${sid} device_id=${targetMeta.device_id}`);
  }

  function handlePcMessage(sid, session, message, rawMessage) {
    if (message.t === 'state') {
      sessionManager.cacheState(sid, message, rawMessage);
      broadcastRawToRemotes(session, rawMessage);
      console.log(`[state broadcast] sid=${sid} remotes=${session.remote_conns.size}`);
      return;
    }

    if (message.t === 'lvl' || message.t === 'devices' || message.t === 'cmd_result' || message.t === 'session_status') {
      broadcastRawToRemotes(session, rawMessage);
      return;
    }

    if (message.t === 'remove_device') {
      handlePcRemoveDevice(sid, session, message);
      return;
    }

    sendProtocolError(session.pc_conn, 'role_violation', `PC cannot send type "${message.t}".`);
  }

  function handleMessage(ws, data, isBinary) {
    if (isBinary) {
      sendProtocolError(ws, 'invalid_payload', 'Binary frames are not supported.');
      return;
    }

    const rawMessage = typeof data === 'string' ? data : data.toString('utf8');
    const validation = validator.validateIncomingMessage(rawMessage);
    if (!validation.ok) {
      sendProtocolError(ws, validation.code, validation.message);
      return;
    }

    const message = validation.message;

    if (message.t === 'ping') {
      const echoTs = Number.isFinite(message.ts) ? message.ts : Date.now();
      sendWsJson(ws, { t: 'pong', ts: echoTs });
      return;
    }

    if (message.t === 'pong') {
      handleLatencyPong(ws, message);
      return;
    }

    if (message.t === 'hello_pc') {
      handleHelloPc(ws, message);
      return;
    }

    if (message.t === 'hello_remote') {
      handleHelloRemote(ws, message);
      return;
    }

    const meta = sessionManager.getSocketMeta(ws);
    if (!meta) {
      sendProtocolError(ws, 'not_authenticated', 'Send hello_pc or hello_remote first.');
      return;
    }

    const session = sessionManager.getSession(meta.sid);
    if (!session) {
      sendProtocolError(ws, 'session_not_found', 'Session no longer exists.');
      return;
    }

    if (!validator.isTypeAllowedForRole(meta.role, message.t)) {
      sendProtocolError(ws, 'role_violation', `Role "${meta.role}" cannot send "${message.t}".`);
      return;
    }

    if (meta.role === 'remote') {
      handleRemoteMessage(ws, meta.sid, session, message, rawMessage);
      return;
    }

    if (meta.role === 'pc') {
      handlePcMessage(meta.sid, session, message, rawMessage);
    }
  }

  function handleClose(ws) {
    stopRemoteLatencyProbe(ws);

    const detached = sessionManager.removeSocket(ws);
    if (!detached) {
      return;
    }

    if (detached.role === 'remote' && detached.session && isWsOpen(detached.session.pc_conn)) {
      sendWsJson(detached.session.pc_conn, buildDevicePayload('device_disconnected', detached.sid, detached));
      return;
    }

    if (detached.role !== 'pc' || !detached.session) {
      return;
    }

    const remoteSockets = Array.from(detached.session.remote_conns);
    broadcastRawToRemotes(detached.session, JSON.stringify({ t: 'session_status', pc_online: 0 }));
    for (const remoteWs of remoteSockets) {
      stopRemoteLatencyProbe(remoteWs);
    }
    sessionManager.terminateSession(detached.sid, {
      remoteCloseCode: 4002,
      remoteCloseReason: 'pc_disconnected'
    });
    console.log(`[session removed] sid=${detached.sid} reason=pc_disconnected`);
  }

  function bindSocket(ws, req) {
    ws.isAlive = true;
    ws.connection_info = extractConnectionInfo(req);

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (data, isBinary) => {
      try {
        handleMessage(ws, data, isBinary);
      } catch (error) {
        sendProtocolError(ws, 'server_error', 'Unexpected relay error.');
        console.error('[relay] message handler failure:', error);
      }
    });

    ws.on('close', () => {
      handleClose(ws);
    });

    ws.on('error', (error) => {
      console.error('[relay] socket error:', error.message);
    });
  }

  return {
    bindSocket
  };
}

module.exports = {
  createMessageRouter
};
