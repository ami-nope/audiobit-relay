# Change Report

Date: 2026-03-12

Current change (most recent)
- Removed the single-remote restriction. Multiple remotes can connect to one session.
- When a remote connects and other devices are already connected, the PC now receives `existing_device_count` and `connected_device_count` in `device_connected`.
- Protocol documentation updated to reflect multi-device behavior.
- Client-provided `sid` always takes precedence over server-generated values; if provided and valid, the server uses it and does not generate a new `sid`.
- Added `/count` live dashboard with a black-white-grey silver UI, rounded 70px corners, and click-to-view session logs.

Summary
This update lets clients provide their own session identifiers and pairing codes when calling `POST /create-session`. If the client does not provide them, the server continues to generate values exactly as before.

What changed
- `relay/server.js`: `POST /create-session` now parses JSON body fields `sid` and `pair_code` (or `code` as an alias). The values are normalized and forwarded into pairing creation.
- `relay/pairingService.js`: Adds validation for client-provided `sid` and `pair_code`, ensures uniqueness, and falls back to generated values when the client does not provide them.

Rules enforced
- `sid` must be exactly 10 characters and only contain `A-Z`, `a-z`, `0-9`.
- `pair_code` must be exactly 6 digits (`0-9`).
- If a provided `sid` already exists, the request is rejected.
- If a provided `pair_code` is already in use, the request is rejected.
- If either value is missing, the server generates it just like before.

Request inputs accepted
- JSON body is optional. If no body is provided, behavior is unchanged.
- `sid` can be a string or a number.
- `pair_code` can be a string or a number.
- `code` is accepted as an alias for `pair_code`.

Normalization details
- `sid` values are trimmed of whitespace. If a numeric `sid` is supplied, it is converted to a string.
- `pair_code` values are trimmed. If a numeric `pair_code` is supplied, it is converted to a string and left-padded to 6 digits.

Examples

Example 1. Client provides both `sid` and `pair_code`
Request
```http
POST /create-session HTTP/1.1
Content-Type: application/json

{
  "sid": "aB3dE9kLmQ",
  "pair_code": "483920"
}
```

Response (201)
```json
{
  "sid": "aB3dE9kLmQ",
  "pair_code": "483920",
  "expires": 1760000000000,
  "qr_url": "https://remote.audiobit.app/connect?sid=aB3dE9kLmQ&code=483920"
}
```

Example 2. Client provides `code` alias
Request
```http
POST /create-session HTTP/1.1
Content-Type: application/json

{
  "sid": "QwErTy1234",
  "code": "102938"
}
```

Response (201)
```json
{
  "sid": "QwErTy1234",
  "pair_code": "102938",
  "expires": 1760000000000,
  "qr_url": "https://remote.audiobit.app/connect?sid=QwErTy1234&code=102938"
}
```

Example 3. Client provides only `sid`
Request
```http
POST /create-session HTTP/1.1
Content-Type: application/json

{
  "sid": "ZxCvBnM123"
}
```

Response (201)
```json
{
  "sid": "ZxCvBnM123",
  "pair_code": "045672",
  "expires": 1760000000000,
  "qr_url": "https://remote.audiobit.app/connect?sid=ZxCvBnM123&code=045672"
}
```

Example 4. Client provides only `pair_code`
Request
```http
POST /create-session HTTP/1.1
Content-Type: application/json

{
  "pair_code": 7
}
```

Response (201)
```json
{
  "sid": "a1B2c3D4e5",
  "pair_code": "000007",
  "expires": 1760000000000,
  "qr_url": "https://remote.audiobit.app/connect?sid=a1B2c3D4e5&code=000007"
}
```

Example 5. Invalid `sid` length
Request
```http
POST /create-session HTTP/1.1
Content-Type: application/json

{
  "sid": "too_short",
  "pair_code": "123456"
}
```

Response (400)
```json
{
  "error": {
    "code": "invalid_request",
    "message": "sid must be 10 alphanumeric characters."
  }
}
```

Example 6. Invalid `pair_code` format
Request
```http
POST /create-session HTTP/1.1
Content-Type: application/json

{
  "sid": "aB3dE9kLmQ",
  "pair_code": "12ab56"
}
```

Response (400)
```json
{
  "error": {
    "code": "invalid_request",
    "message": "pair_code must be a 6-digit string."
  }
}
```

Example 7. `sid` already in use
Request
```http
POST /create-session HTTP/1.1
Content-Type: application/json

{
  "sid": "aB3dE9kLmQ",
  "pair_code": "483920"
}
```

Response (400)
```json
{
  "error": {
    "code": "invalid_request",
    "message": "sid is already in use."
  }
}
```

Example 8. `pair_code` already in use
Request
```http
POST /create-session HTTP/1.1
Content-Type: application/json

{
  "sid": "NewSid1234",
  "pair_code": "483920"
}
```

Response (400)
```json
{
  "error": {
    "code": "invalid_request",
    "message": "pair_code is already in use."
  }
}
```

Example 9. Empty body (unchanged behavior)
Request
```http
POST /create-session HTTP/1.1
Content-Type: application/json

{}
```

Response (201)
```json
{
  "sid": "fG7hJ8kL9M",
  "pair_code": "654321",
  "expires": 1760000000000,
  "qr_url": "https://remote.audiobit.app/connect?sid=fG7hJ8kL9M&code=654321"
}
```

Compatibility notes
- No existing command or script was modified.
- The `/create-session` endpoint remains backward compatible.
- Error handling still returns `400` with `invalid_request` for invalid inputs.

Files touched (create-session update)
- `relay/server.js`
- `relay/pairingService.js`

---

Multi-device Update (2026-03-12)

Summary
The relay now allows multiple remotes per session. When a new remote connects and there was already at least one device connected, the PC is explicitly told that other devices are already connected.

What changed
- `relay/sessionManager.js`: removed the single-remote rejection. Multiple remotes can register to the same `sid`.
- `relay/messageRouter.js`: when a remote connects and the session already has other remotes, the `device_connected` payload to PC includes:
  - `existing_device_count`: number of devices already connected before this one.
  - `connected_device_count`: total devices connected after this one joined.
- `docs/PROTOCOL.md`: updated lifecycle/validation rules and documented the new `device_connected` fields.

Example: second device connects to same session

```json
{
  "t": "device_connected",
  "sid": "a1b2c3d4e5f6a1b2c3d4e5f6",
  "device_id": "my-device-2",
  "device_name": "Jane Tablet",
  "device_location": "New York, USA",
  "connection_type": "wifi",
  "existing_device_count": 1,
  "connected_device_count": 2
}
```

Behavior notes
- The relay still enforces `device_id` uniqueness across different sessions.
- No existing commands were removed or renamed; the change adds optional fields to the existing `device_connected` event.

Files touched (multi-device update)
- `relay/sessionManager.js`
- `relay/messageRouter.js`
- `docs/PROTOCOL.md`

---

Count Dashboard Update (2026-03-12)

Summary
Added a new `/count` live dashboard that shows active connections and connection durations in a table. Clicking any row loads recent logs for that session.

What changed
- `relay/server.js`: added `/count`, `/count/data`, and `/count/logs` endpoints plus a live HTML dashboard UI.
- `relay/activityLog.js`: new in-memory log buffer to store recent session events.
- `relay/messageRouter.js`: records connect/disconnect/remove events into the activity log.
- `relay/sessionManager.js`: PC metadata now includes `connected_at` and connection info for display.
- `docs/PROTOCOL.md`: documented the new `/count` endpoints.

UI notes
- Theme: black, white, grey, silver.
- Rounded corners: 70px on main panels.
- Auto-refresh: every 2.5 seconds.

Example: fetch live snapshot
```http
GET /count/data HTTP/1.1
```

Example: fetch logs for a session
```http
GET /count/logs?sid=a1b2c3d4e5f6a1b2c3d4e5f6 HTTP/1.1
```

Files touched (count dashboard)
- `relay/server.js`
- `relay/activityLog.js`
- `relay/messageRouter.js`
- `relay/sessionManager.js`
- `docs/PROTOCOL.md`
