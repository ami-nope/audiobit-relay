# AudioBit Remote Relay — Protocol Specification

## 1. Transport & Configuration

| Parameter | Default | Env Var |
|---|---|---|
| Port | `8080` | `PORT` |
| WebSocket path | `/ws` | `WS_PATH` |
| Session TTL | 300 000 ms (5 min) | `SESSION_TTL_MS` |
| Heartbeat interval | 15 000 ms (15 s) | `HEARTBEAT_INTERVAL_MS` |
| Max message size | 65 536 bytes (64 KB) | `MAX_MESSAGE_BYTES` |
| QR base URL | `https://remote.audiobit.app/connect` | `QR_BASE_URL` |

- Transport: **WebSocket** (text frames only — binary frames are rejected).
- All messages are **JSON objects** with a mandatory `"t"` (type) string field.
- Session IDs are 24-character hex strings (12 random bytes).
- Pairing codes are 6-digit zero-padded numeric strings (`/^\d{6}$/`).

---

## 2. HTTP Endpoints

### `GET /`

Service discovery.

**Response 200:**

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

Creates a new session with a unique pairing code and session ID.

**Response 201:**

```json
{
  "sid": "a1b2c3d4e5f6a1b2c3d4e5f6",
  "pair_code": "482901",
  "expires": 1741500300000,
  "qr_url": "https://remote.audiobit.app/connect?sid=a1b2c3d4e5f6a1b2c3d4e5f6&code=482901"
}
```

### `GET /health`

**Response 200:**

```json
{
  "ok": true,
  "sessions": 3,
  "now": 1741500000000
}
```

### `GET /connect?sid=...&code=...`

Used by QR code redirect on the web. Returns the connection parameters.

**Response 200:**

```json
{
  "sid": "a1b2c3d4e5f6a1b2c3d4e5f6",
  "pair_code": "482901"
}
```

### `OPTIONS *`

Returns `204` with CORS headers (`Access-Control-Allow-Origin: *`).

### Error format (all HTTP errors)

```json
{
  "error": {
    "code": "not_found",
    "message": "Route not found."
  }
}
```

---

## 3. All WebSocket Message Types

| Type | `"t"` value | Direction | Sender → Receiver |
|---|---|---|---|
| PC Handshake | `hello_pc` | Client → Server | PC → Relay |
| Remote Handshake | `hello_remote` | Client → Server | Remote → Relay |
| Handshake Ack | `hello_ok` | Server → Client | Relay → PC/Remote |
| Session Status | `session_status` | Server → Client (broadcast) | Relay → Remote(s) |
| State Update | `state` | PC → Relay → Remote(s) | PC → Relay (broadcast) |
| Level/Meter Update | `lvl` | PC → Relay → Remote(s) | PC → Relay (broadcast) |
| Device List | `devices` | PC → Relay → Remote(s) | PC → Relay (broadcast) |
| Command | `cmd` | Remote → Relay → PC | Remote → Relay (forward) |
| Command Result | `cmd_result` | PC → Relay → Remote(s) | PC → Relay (broadcast) |
| Resync Request | `resync` | Remote → Relay | Remote → Relay |
| Ping | `ping` | Either → Relay | Any → Relay |
| Pong | `pong` | Relay → Client | Relay → Any |
| Error | `err` | Server → Client | Relay → Any |

### Role-allowed types (post-handshake)

| Role | Allowed `"t"` values |
|---|---|
| **pc** | `state`, `lvl`, `devices`, `cmd_result`, `session_status`, `ping`, `pong` |
| **remote** | `cmd`, `resync`, `ping`, `pong` |

Any other type from an authenticated socket returns a `role_violation` error.

---

## 4. Message Definitions

### 4.1 Handshake Messages

#### `hello_pc` — PC identifies itself to the relay

```json
{
  "t": "hello_pc",
  "sid": "a1b2c3d4e5f6a1b2c3d4e5f6"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `t` | string | Yes | `"hello_pc"` |
| `sid` | string | Yes | Session ID (24-char hex). Must be non-empty. |

#### `hello_remote` — Remote identifies itself to the relay

```json
{
  "t": "hello_remote",
  "sid": "a1b2c3d4e5f6a1b2c3d4e5f6",
  "pair_code": "482901"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `t` | string | Yes | `"hello_remote"` |
| `sid` | string | Yes | Session ID (24-char hex). Must be non-empty. |
| `pair_code` | string | Yes | 6-digit numeric code. Must match `/^\d{6}$/`. |

#### `hello_ok` — Handshake success (relay → client)

```json
{
  "t": "hello_ok",
  "role": "pc",
  "sid": "a1b2c3d4e5f6a1b2c3d4e5f6"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `t` | string | Yes | `"hello_ok"` |
| `role` | string | Yes | `"pc"` or `"remote"` |
| `sid` | string | Yes | Session ID |

---

### 4.2 Session Status

#### `session_status` — PC online/offline notification (relay → remotes)

```json
{
  "t": "session_status",
  "pc_online": 1
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `t` | string | Yes | `"session_status"` |
| `pc_online` | number | Yes | `1` = PC is connected, `0` = PC is disconnected |

**Sent when:**

- A remote connects (receives current PC status).
- A PC connects (all remotes receive `pc_online: 1`).
- A PC disconnects (all remotes receive `pc_online: 0`).
- The PC can also broadcast `session_status` itself (forwarded to all remotes).

---

### 4.3 State Update

#### `state` — Full application state (PC → remotes)

The relay caches the latest `state` message per session. New remotes receive the cached state immediately after `hello_ok`.

```json
{
  "t": "state",
  "rev": 42,
  "...": "application-defined fields"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `t` | string | Yes | `"state"` |
| `rev` | number | Optional | Monotonic revision number. If omitted, the relay auto-increments. |
| *(other)* | any | Optional | Application-defined state payload (volumes, mute status, etc.) |

**Relay behavior:** Cached in `last_state` / `last_state_raw`. Broadcast as raw string to all connected remotes.

---

### 4.4 Level/Meter Update

#### `lvl` — Audio level meters (PC → remotes)

```json
{
  "t": "lvl",
  "...": "application-defined meter data"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `t` | string | Yes | `"lvl"` |
| *(other)* | any | Optional | Application-defined level/meter data |

**Relay behavior:** Broadcast raw to all remotes. Not cached.

---

### 4.5 Device List

#### `devices` — Audio device enumeration (PC → remotes)

```json
{
  "t": "devices",
  "...": "application-defined device list"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `t` | string | Yes | `"devices"` |
| *(other)* | any | Optional | Application-defined device enumeration |

**Relay behavior:** Broadcast raw to all remotes. Not cached.

---

### 4.6 Command Messages

#### `cmd` — Command from remote (remote → PC)

```json
{
  "t": "cmd",
  "...": "application-defined command fields"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `t` | string | Yes | `"cmd"` |
| *(other)* | any | Optional | Application-defined command payload |

**Relay behavior:** Forwarded raw to the PC's WebSocket. If the PC is offline, the remote receives `session_status { pc_online: 0 }` + `err { code: "pc_offline" }`.

#### `cmd_result` — Command response (PC → remotes)

```json
{
  "t": "cmd_result",
  "...": "application-defined result fields"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `t` | string | Yes | `"cmd_result"` |
| *(other)* | any | Optional | Application-defined result payload |

**Relay behavior:** Broadcast raw to all remotes. Not cached.

---

### 4.7 Resync

#### `resync` — Request cached state (remote → relay)

```json
{
  "t": "resync"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `t` | string | Yes | `"resync"` |

**Relay behavior:** Sends the cached `state` raw message back to the requesting remote only. No-op if no cached state exists.

---

### 4.8 Heartbeat / Ping-Pong

#### `ping` — Application-level ping (any → relay)

```json
{
  "t": "ping"
}
```

#### `pong` — Application-level pong (relay → client)

```json
{
  "t": "pong",
  "ts": 1741500000000
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `t` | string | Yes | `"pong"` |
| `ts` | number | Yes | Server timestamp (ms since epoch) |

**Additionally**, the relay sends WebSocket-level `ping` frames every **15 seconds**. Clients must respond with a WebSocket-level `pong` (handled automatically by most WS libraries). Sockets that fail to respond are terminated on the next heartbeat cycle.

---

### 4.9 Error Messages

#### `err` — Protocol error (relay → client)

```json
{
  "t": "err",
  "code": "invalid_json",
  "message": "Message is not valid JSON."
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `t` | string | Yes | `"err"` |
| `code` | string | Yes | Machine-readable error code |
| `message` | string | Yes | Human-readable description |

**All error codes:**

| Code | Condition |
|---|---|
| `invalid_payload` | Binary frame received, or non-string payload |
| `payload_too_large` | Message exceeds 64 KB |
| `invalid_json` | JSON parse failure |
| `invalid_message` | Root is not a plain object |
| `missing_type` | `"t"` field missing or empty |
| `unsupported_type` | `"t"` value not in supported set |
| `invalid_sid` | `sid` missing or empty on `hello_pc` / `hello_remote` |
| `invalid_pair_code` | `pair_code` missing or not 6 digits on `hello_remote` |
| `session_not_found` | Session ID does not exist |
| `session_expired` | Session TTL elapsed without a PC connection |
| `pc_already_connected` | Another PC socket is already bound |
| `pair_code_invalid` | Pairing code doesn't match session |
| `not_authenticated` | Message sent before `hello_pc` / `hello_remote` |
| `role_violation` | Role cannot send this message type |
| `pc_offline` | Remote sent `cmd` but PC is disconnected |
| `server_error` | Unexpected internal error |

**Fatal errors** (connection closed with code `1008` after the error message): `session_not_found`, `session_expired`, `pc_already_connected`, `pair_code_invalid`.

---

## 5. Full Lifecycle

```
┌──────────┐         ┌───────────┐         ┌──────────────┐
│  PC App  │         │   Relay   │         │ Remote (App/ │
│          │         │  Server   │         │   Web UI)    │
└────┬─────┘         └─────┬─────┘         └──────┬───────┘
     │                     │                      │
     │ 1. POST /create-session                    │
     │ ──────────────────► │                      │
     │ ◄── 201 { sid,      │                      │
     │     pair_code,       │                      │
     │     expires, qr_url }│                      │
     │                     │                      │
     │ 2. Display pair_code│                      │
     │    and/or QR code   │                      │
     │    to user          │                      │
     │                     │                      │
     │ 3. WS connect /ws   │                      │
     │ ──────────────────► │                      │
     │                     │                      │
     │ 4. hello_pc {sid}   │                      │
     │ ──────────────────► │                      │
     │ ◄── hello_ok        │                      │
     │     {role:"pc",sid} │                      │
     │                     │                      │
     │                     │  5. User enters code │
     │                     │     or scans QR      │
     │                     │                      │
     │                     │  6. WS connect /ws   │
     │                     │ ◄────────────────────│
     │                     │                      │
     │                     │  7. hello_remote     │
     │                     │     {sid, pair_code} │
     │                     │ ◄────────────────────│
     │                     │                      │
     │                     │ ──► hello_ok         │
     │                     │     {role:"remote",  │
     │                     │      sid}            │
     │                     │ ──► session_status   │
     │                     │     {pc_online: 1}   │
     │                     │ ──► cached state     │
     │                     │     (if available)   │
     │                     │ ────────────────────►│
     │                     │                      │
     │ ◄── session_status  │                      │
     │     {pc_online: 1}  │                      │
     │   (broadcast to     │                      │
     │    existing remotes)│                      │
     │                     │                      │
     │ 8. state {t:"state",│                      │
     │    rev:1, ...}      │                      │
     │ ──────────────────► │ ────────────────────►│
     │                     │  (broadcast+cache)   │
     │                     │                      │
     │ 9. lvl {t:"lvl",...}│                      │
     │ ──────────────────► │ ────────────────────►│
     │                     │  (broadcast, no cache)│
     │                     │                      │
     │                     │ 10. cmd {t:"cmd",...} │
     │ ◄──────────────────────────────────────────│
     │   (forwarded to PC) │                      │
     │                     │                      │
     │ 11. cmd_result      │                      │
     │     {t:"cmd_result"}│                      │
     │ ──────────────────► │ ────────────────────►│
     │                     │  (broadcast)         │
     │                     │                      │
     │ 12. PC disconnects  │                      │
     │ ─── close ────────► │                      │
     │                     │ ──► session_status   │
     │                     │     {pc_online: 0}   │
     │                     │ ────────────────────►│
     │                     │                      │
     │                     │  Session TTL starts  │
     │                     │  (5 min countdown)   │
```

### Lifecycle summary

1. **Session creation** — PC calls `POST /create-session`. Receives `sid`, `pair_code`, `expires`, `qr_url`.
2. **PC connects** — Opens WebSocket to `/ws`, sends `hello_pc` with `sid`. Receives `hello_ok`. Session expiry is disabled (set to `MAX_SAFE_INTEGER`).
3. **Remote pairs** — User enters 6-digit code or scans QR. Remote opens WebSocket to `/ws`, sends `hello_remote` with `sid` + `pair_code`. Receives `hello_ok`, then `session_status`, then cached `state` (if any).
4. **Command routing** — Remotes send `cmd` messages that are forwarded to the PC. PC replies with `cmd_result` broadcast to all remotes.
5. **State updates** — PC sends `state` (cached + broadcast), `lvl` (broadcast only), `devices` (broadcast only).
6. **Resync** — A remote can request the latest cached `state` by sending `resync`.
7. **PC disconnect** — All remotes are notified with `session_status { pc_online: 0 }`. Session TTL restarts (5 min). If no PC reconnects, the session is cleaned up and all remaining remotes are closed with code `4001`.
8. **Heartbeat** — Every 15s the relay pings all sockets at the WebSocket protocol level. Unresponsive sockets are terminated.

---

## 6. Validation Rules

| Rule | Detail |
|---|---|
| Frame type | Only text frames accepted. Binary → `invalid_payload` error. |
| Max size | 64 KB per message. Enforced at both `ws` library level (`maxPayload`) and validator level. |
| JSON structure | Must be a non-array object. |
| Type field | `"t"` must be a non-empty string and one of the 13 supported types. |
| `hello_pc` | `sid` must be a non-empty string. |
| `hello_remote` | `sid` must be a non-empty string; `pair_code` must match `/^\d{6}$/`. |
| Authentication | Any message other than `hello_pc`, `hello_remote`, `ping`, `pong` requires prior successful handshake. |
| Role enforcement | After handshake, only role-allowed types are accepted (see table in §3). |
| Single PC | Only one PC socket per session. Second attempt → `pc_already_connected` + close. |
| Multiple remotes | Unlimited concurrent remotes per session. |
| Pair code match | Must exactly match the code assigned at session creation. |

---

## 7. Rate Limits & Intervals

| Mechanism | Value | Detail |
|---|---|---|
| WebSocket heartbeat (ping/pong) | Every 15 s | Server sends WS-level ping. Client must reply. Miss = terminate. |
| Session TTL | 5 min (300 s) | From creation until a PC connects, or after PC disconnects. |
| Max message size | 64 KB | Hard limit, closes frame if exceeded. |
| Session cleanup | Every 15 s | Runs on the same heartbeat timer. Expired sessions are purged. |
| Pairing code allocation | Max 50 attempts | If no unique 6-digit code found after 50 tries, session creation fails. |

No explicit per-client message rate limiting is implemented at the relay level.

---

## 8. WebSocket Close Codes

| Code | Meaning |
|---|---|
| `1008` (Policy Violation) | Fatal handshake error (bad sid, expired, wrong pair code, PC already connected) |
| `4001` | Session expired (sent to orphaned remotes during cleanup) |
| `1000` | Normal closure |
