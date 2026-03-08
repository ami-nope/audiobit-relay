'use strict';

const { closeWs, isWsOpen, sendWsJson } = require('./utils');

const POLICY_VIOLATION_CLOSE = 1008;

function createMessageRouter({ sessionManager, validator }) {
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
      session.remote_conns.delete(ws);
      sessionManager.clearSocketMeta(ws);
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
    console.log(`[PC connected] sid=${message.sid}`);
  }

  function handleHelloRemote(ws, message) {
    const result = sessionManager.registerRemote(message.sid, message.pair_code, ws);
    if (!result.ok) {
      sendProtocolError(ws, result.code, result.message);
      closeWs(ws, POLICY_VIOLATION_CLOSE, result.message);
      return;
    }

    const session = result.session;
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

    console.log(`[remote connected] sid=${message.sid} remotes=${session.remote_conns.size}`);
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
      sendWsJson(ws, { t: 'pong', ts: Date.now() });
      return;
    }

    if (message.t === 'pong') {
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
    const detached = sessionManager.removeSocket(ws);
    if (!detached || detached.role !== 'pc' || !detached.session) {
      return;
    }

    broadcastRawToRemotes(detached.session, JSON.stringify({ t: 'session_status', pc_online: 0 }));
  }

  function bindSocket(ws) {
    ws.isAlive = true;

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
