# AudioBit Remote Relay - Protocol Specification

## 1. Transport and Configuration

| Parameter | Default | Env Var |
|---|---|---|
| Port | `8080` | `PORT` |
| WebSocket path | `/ws` | `WS_PATH` |
| Session TTL | `300000` ms (5 min) | `SESSION_TTL_MS` |
| Heartbeat interval | `15000` ms (15 s) | `HEARTBEAT_INTERVAL_MS` |
| Max message size | `65536` bytes (64 KB) | `MAX_MESSAGE_BYTES` |
| QR base URL | `https://remote.audiobit.app/connect` | `QR_BASE_URL` |

- Transport: WebSocket text frames only. Binary frames are rejected.
- Messages are JSON objects with required string field `t`.
- Session IDs are 24-char hex strings.
- Pair codes are 6-digit strings (`/^\d{6}$/`).

---

## 2. HTTP Endpoints

### `GET /`

Service discovery.

**Response 200**

```json
{
  "service": "AudioBit Remote Relay",
  "now": 1741500000000,
  "endpoints": {
    "create_session": { "method": "POST", "path": "/create-session" },
    "health": { "method": "GET", "path": "/health" },
    "ws": { "method": "GET (Upgrade)", "path": "/ws" }
  }
}
```

### `POST /create-session`

Creates a new session with a unique pair code and session ID.

**Response 201**

```json
{
  "sid": "a1b2c3d4e5f6a1b2c3d4e5f6",
  "pair_code": "482901",
  "expires": 1741500300000,
  "qr_url": "https://remote.audiobit.app/connect?sid=a1b2c3d4e5f6a1b2c3d4e5f6&code=482901"
}
```

### `GET /health`

**Response 200**

```json
{
  "ok": true,
  "sessions": 3,
  "now": 1741500000000
}
```

### `GET /connect?sid=...&code=...`

Returns query values in JSON.

**Response 200**

```json
{
  "sid": "a1b2c3d4e5f6a1b2c3d4e5f6",
  "pair_code": "482901"
}
```

### `OPTIONS *`

Returns `204` with CORS headers.

### HTTP Error Format

```json
{
  "error": {
    "code": "not_found",
    "message": "Route not found."
  }
}
```

---

## 3. WebSocket Message Types

| Type | `t` | Direction | Sender -> Receiver |
|---|---|---|---|
| PC Handshake | `hello_pc` | Client -> Server | PC -> Relay |
| Remote Handshake | `hello_remote` | Client -> Server | Remote -> Relay |
| Handshake Ack | `hello_ok` | Server -> Client | Relay -> PC/Remote |
| Session Status | `session_status` | Broadcast | Relay/PC -> Remote |
| State Update | `state` | Routed | PC -> Relay -> Remote |
| Level Update | `lvl` | Routed | PC -> Relay -> Remote |
| Audio Devices | `devices` | Routed | PC -> Relay -> Remote |
| Remote Command | `cmd` | Routed | Remote -> Relay -> PC |
| Command Result | `cmd_result` | Routed | PC -> Relay -> Remote |
| Resync Request | `resync` | Client -> Server | Remote -> Relay |
| Remove Device | `remove_device` | Client -> Server | PC -> Relay |
| Ping | `ping` | Client/Server | Any <-> Relay |
| Pong | `pong` | Client/Server | Any <-> Relay |
| Device Connected | `device_connected` | Server -> Client | Relay -> PC |
| Device Disconnected | `device_disconnected` | Server -> Client | Relay -> PC |
| Device Removed | `device_removed` | Server -> Client | Relay -> PC/Remote |
| Device Latency | `device_latency` | Server -> Client | Relay -> PC |
| Error | `err` | Server -> Client | Relay -> Any |

### Role-allowed Types (post-auth)

| Role | Allowed `t` values |
|---|---|
| `pc` | `state`, `lvl`, `devices`, `cmd_result`, `session_status`, `remove_device`, `ping`, `pong` |
| `remote` | `cmd`, `resync`, `ping`, `pong` |

Any disallowed type after auth returns `role_violation`.

---

## 4. Message Definitions

### 4.1 Handshake

#### `hello_pc`

```json
{
  "t": "hello_pc",
  "sid": "a1b2c3d4e5f6a1b2c3d4e5f6"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `t` | string | Yes | Must be `hello_pc` |
| `sid` | string | Yes | Target session id |

#### `hello_remote`

```json
{
  "t": "hello_remote",
  "sid": "a1b2c3d4e5f6a1b2c3d4e5f6",
  "pair_code": "482901",
  "device_id": "my-device-1",
  "device_name": "John Phone",
  "device_location": "New York, USA",
  "connection_type": "wifi"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `t` | string | Yes | Must be `hello_remote` |
| `sid` | string | Yes | Target session id |
| `pair_code` | string | Yes | Must match `/^\d{6}$/` |
| `device_id` | string | No | Stable identifier for cross-session lock |
| `device_name` | string | No | User-facing name |
| `device_location` | string | No | User-facing location |
| `connection_type` | string | No | `wifi`, `mobile`, etc. |

Notes:
- Relay also captures `ip` and `user_agent` from the WebSocket upgrade request.
- If `device_id` is not supplied, relay derives one from connection fingerprint.

#### `hello_ok`

```json
{
  "t": "hello_ok",
  "role": "remote",
  "sid": "a1b2c3d4e5f6a1b2c3d4e5f6"
}
```

| Field | Type | Required |
|---|---|---|
| `t` | string | Yes |
| `role` | string | Yes (`pc` or `remote`) |
| `sid` | string | Yes |

### 4.2 Session Status

```json
{
  "t": "session_status",
  "pc_online": 1
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `t` | string | Yes | `session_status` |
| `pc_online` | number | Yes | `1` online, `0` offline |

Sent when:
- Remote successfully handshakes (current PC status).
- PC connects (`pc_online: 1` broadcast to remotes).
- PC disconnects (`pc_online: 0` sent before remotes are closed).
- PC may also send `session_status` to relay for remote broadcast.

### 4.3 `state`

```json
{
  "t": "state",
  "rev": 42
}
```

- Relay caches latest raw `state` per session.
- New remote receives cached `state` after `hello_ok`.

### 4.4 `lvl`

PC meter update, broadcast raw to remote.

### 4.5 `devices`

PC audio device list, broadcast raw to remote.

### 4.6 `cmd` and `cmd_result`

- Remote `cmd` is forwarded raw to PC.
- If PC offline, remote receives:
  - `{"t":"session_status","pc_online":0}`
  - `{"t":"err","code":"pc_offline","message":"PC is not connected."}`
- PC `cmd_result` is broadcast raw to remote.

### 4.7 `resync`

```json
{
  "t": "resync"
}
```

Relay sends cached raw `state` back to the requesting remote (if present).

### 4.8 `remove_device` (PC admin action)

```json
{
  "t": "remove_device",
  "device_id": "my-device-1"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `t` | string | Yes | Must be `remove_device` |
| `device_id` | string | No | If omitted, removes the currently connected device for that session |

Behavior:
- Relay disconnects target remote with close code `4003`.
- Relay sends `device_removed` to both PC and remote.
- If no target found, PC gets `device_not_found` error.

### 4.9 Device Events (Relay -> PC)

Common payload fields:

| Field | Type | Notes |
|---|---|---|
| `t` | string | `device_connected`, `device_disconnected`, `device_removed`, `device_latency` |
| `sid` | string | Session id |
| `device_id` | string or null | Device id |
| `device_name` | string or null | Name |
| `device_location` | string or null | Location |
| `connection_type` | string | Defaults to `websocket` |
| `ip` | string or null | Source IP |
| `user_agent` | string or null | UA string |

`device_connected` example:

```json
{
  "t": "device_connected",
  "sid": "a1b2c3d4e5f6a1b2c3d4e5f6",
  "device_id": "my-device-1",
  "device_name": "John Phone",
  "device_location": "New York, USA",
  "connection_type": "wifi",
  "ip": "203.0.113.5",
  "user_agent": "Mozilla/5.0 ..."
}
```

`device_disconnected` example:

```json
{
  "t": "device_disconnected",
  "sid": "a1b2c3d4e5f6a1b2c3d4e5f6",
  "device_id": "my-device-1"
}
```

`device_removed` example:

```json
{
  "t": "device_removed",
  "sid": "a1b2c3d4e5f6a1b2c3d4e5f6",
  "device_id": "my-device-1",
  "removed_by": "pc"
}
```

`device_latency` example:

```json
{
  "t": "device_latency",
  "sid": "a1b2c3d4e5f6a1b2c3d4e5f6",
  "device_id": "my-device-1",
  "ts": 1741500000000,
  "rtt_ms": 42,
  "measured_at": 1741500000042
}
```

### 4.10 Ping/Pong and Latency

App-level ping/pong:

```json
{ "t": "ping", "ts": 1741500000000 }
```

```json
{ "t": "pong", "ts": 1741500000000 }
```

Behavior:
- Relay responds to `ping` with `pong`.
- If `ping.ts` is provided and valid, relay echoes that value in `pong.ts`.
- Relay accepts incoming `pong` from clients.

Remote latency probe:
- Relay sends app-level `ping` to each connected remote every 4 seconds:
  - `{"t":"ping","ts":<now>,"source":"relay_latency"}`
- Remote should reply with `pong` echoing the same `ts`.
- Relay computes RTT and sends `device_latency` to PC.

WS-level heartbeat:
- Relay also sends WebSocket control-frame ping every 15 seconds.
- Unresponsive sockets are terminated.

### 4.11 Errors

```json
{
  "t": "err",
  "code": "invalid_json",
  "message": "Message is not valid JSON."
}
```

| Code | Condition |
|---|---|
| `invalid_payload` | Binary frame or invalid non-string payload |
| `payload_too_large` | Message > `MAX_MESSAGE_BYTES` |
| `invalid_json` | JSON parse failure |
| `invalid_message` | JSON root is not an object |
| `missing_type` | Missing/empty `t` |
| `unsupported_type` | Unknown `t` |
| `invalid_sid` | Missing/empty `sid` in `hello_pc`/`hello_remote` |
| `invalid_pair_code` | Invalid `pair_code` in `hello_remote` |
| `invalid_device_id` | Invalid `device_id` where provided |
| `invalid_device_name` | Invalid `device_name` where provided |
| `invalid_device_location` | Invalid `device_location` where provided |
| `invalid_connection_type` | Invalid `connection_type` where provided |
| `invalid_timestamp` | Invalid `ts` in `ping`/`pong` where provided |
| `session_not_found` | Session id does not exist |
| `session_expired` | Session expired before PC connected |
| `pc_already_connected` | A different PC is already attached |
| `pair_code_invalid` | Pair code mismatch |
| `device_already_connected` | A device is already connected to this session |
| `device_bound_to_other_session` | Same device id active in another session |
| `device_not_found` | `remove_device` target not found |
| `not_authenticated` | Message before hello |
| `role_violation` | Role cannot send that message type |
| `pc_offline` | Remote sent `cmd` while PC unavailable |
| `server_error` | Unexpected relay error |

Fatal handshake errors (relay sends `err`, then closes with `1008`):
- `session_not_found`
- `session_expired`
- `pc_already_connected`
- `pair_code_invalid`
- `device_already_connected`
- `device_bound_to_other_session`

---

## 5. Lifecycle

1. PC creates session via `POST /create-session`.
2. PC connects to WS and sends `hello_pc`.
3. Remote connects and sends `hello_remote` with `sid` + `pair_code` (+ optional device metadata).
4. Relay allows only one active remote per session.
5. Relay forwards remote `cmd` to PC; PC replies with `cmd_result`.
6. Relay forwards PC `state`/`lvl`/`devices` to remote (`state` is cached).
7. Relay sends remote device events to PC (`device_connected`, `device_disconnected`, `device_removed`).
8. PC can remove remote via `remove_device`.
9. Relay measures remote RTT every 4s and reports `device_latency` to PC.
10. On PC disconnect, relay sends `session_status { pc_online: 0 }` to remote, then closes remote sockets and removes the session immediately.

---

## 6. Validation Rules

| Rule | Detail |
|---|---|
| Frame type | Text only; binary -> `invalid_payload` |
| Max size | 64 KB |
| Message root | Must be object |
| Type field | `t` required and must be one of 18 supported types |
| `hello_pc` | `sid` required |
| `hello_remote` | `sid` + valid `pair_code` required |
| Optional remote identity fields | If present, must be non-empty strings (`device_id`, `device_name`, `device_location`, `connection_type`) |
| `remove_device.device_id` | If present, must be non-empty string |
| `ping.ts` / `pong.ts` | If present, must be finite number |
| Authentication | Non-hello non-ping/pong messages require prior successful hello |
| Role enforcement | Only role-allowed `t` values accepted |
| Single PC | One PC socket per session |
| Single remote | One remote socket per session |
| Device lock | Same `device_id` cannot be active in multiple sessions |
| Pair code match | Must match session pair code |

---

## 7. Intervals and Limits

| Mechanism | Value | Detail |
|---|---|---|
| WS heartbeat ping | Every 15 s | Control-frame ping from relay |
| Remote latency probe | Every 4 s | App-level `ping` from relay to remote |
| Session TTL | 5 min | Applies while waiting for first PC connection |
| Session cleanup | Every 15 s | Expired pre-PC sessions are removed |
| Max message size | 64 KB | Enforced by `ws` and validator |
| Pair code allocation attempts | Max 50 | Session creation fails if exhausted |

---

## 8. WebSocket Close Codes

| Code | Meaning |
|---|---|
| `1008` | Fatal handshake/policy violation |
| `4001` | Session expired during cleanup |
| `4002` | Session terminated because PC disconnected |
| `4003` | Remote removed by PC admin action |
| `1000` | Normal closure |
