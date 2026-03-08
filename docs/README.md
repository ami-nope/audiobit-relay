# AudioBit Remote Relay

Node.js WebSocket relay server for AudioBit Remote protocol.

## Features

- WebSocket message routing with `ws`
- Numeric pairing codes (6-digit)
- QR-compatible link generation
- One PC + multiple remotes per session
- In-memory latest `state` cache with instant replay to new remotes
- Ping/pong heartbeat and dead socket cleanup
- Railway-ready (`PORT` env support)

## Project Structure

```text
relay/
 ├ package.json
 ├ server.js
 ├ sessionManager.js
 ├ pairingService.js
 ├ messageRouter.js
 ├ protocolValidator.js
 ├ config.js
 ├ utils.js
 └ README.md
```

## Install and Run

```bash
cd relay
npm install
npm start
```

Server listens on `process.env.PORT` (default `8080`).

## Environment Variables

- `PORT` (default: `8080`)
- `SESSION_TTL_MS` (default: `300000`)
- `HEARTBEAT_INTERVAL_MS` (default: `15000`)
- `MAX_MESSAGE_BYTES` (default: `65536`)
- `QR_BASE_URL` (default: `https://remote.audiobit.app/connect`)
- `WS_PATH` (default: `/ws`)

## HTTP Endpoints

### `POST /create-session`

Creates a session and pairing code.

Response:

```json
{
  "sid": "5a97d2174f70f40f57f3f2d9",
  "pair_code": "593281",
  "expires": 1760000000000,
  "qr_url": "https://remote.audiobit.app/connect?sid=5a97d2174f70f40f57f3f2d9&code=593281"
}
```

### `GET /health`

Basic service health and active session count.

### `GET /connect?sid=...&code=...`

Returns parsed QR values (`sid`, `pair_code`) as JSON.

## WebSocket Protocol

Connect to:

- `ws://<host>/ws` (default)
- `ws://<host>/` (also accepted)

### Handshake

PC:

```json
{ "t": "hello_pc", "sid": "SESSION_ID" }
```

Remote:

```json
{ "t": "hello_remote", "sid": "SESSION_ID", "pair_code": "593281" }
```

Successful handshake:

```json
{ "t": "hello_ok", "role": "pc|remote", "sid": "SESSION_ID" }
```

Remote also receives:

```json
{ "t": "session_status", "pc_online": 0|1 }
```

If cached state exists, remote receives latest `state` message immediately after join.

### Routing Rules

- Remote -> PC: `cmd`
- PC -> all remotes: `state`, `lvl`, `devices`, `cmd_result`, `session_status`
- Remote `resync`: relay sends cached `state` (if available)
- System: `ping`, `pong`, `err`

### Disconnect Behavior

- When PC disconnects, remotes get:

```json
{ "t": "session_status", "pc_online": 0 }
```

- When remote disconnects, it is removed from session remote set.

## Logging

Server logs these events:

- `session created`
- `PC connected`
- `remote connected`
- `command forwarded`
- `state broadcast`

## Railway Deployment

1. Create Railway project and deploy this `relay` folder.
2. Ensure start command is `npm start`.
3. Railway provides `PORT`; server already uses it.
4. Optionally set `QR_BASE_URL` to your production remote URL.
