# UTG Messenger

Student messaging application using React, Express, Socket.IO, PostgreSQL, Redis, WebRTC, and coturn.

## Run locally

Requirements: Docker Compose and Node.js 20 or newer.

From the project root, start the database, API instances, Redis, and TURN server:

```sh
docker compose up --build
```

In another terminal, start the development client:

```sh
npm install --prefix client
npm run dev --prefix client
```

Open the Vite URL (normally <http://localhost:5173>). The API and database run in Docker; the Vite development server proxies API and Socket.IO requests to `localhost:4000`.

Seeded demo accounts:

| Username | Password |
|---|---|
| alice | `Password123!` |
| bob | `Password123!` |

Admin: `admin@utg.edu.gm` / `ChangeMe123!`. These are development credentials; reset the password from the admin user list before exposing the service. `ADMIN_PASSWORD` sets the seed password on a fresh database.

To run a second client against the other API instance:

```sh
VITE_API=http://localhost:4001 npm run dev --prefix client -- --port 5174
```

Stop the stack with Ctrl+C. Uploaded files are stored in the Compose `uploads` volume; PostgreSQL data is in `pgdata`.

## Features

- Direct and group messaging; edit/delete own messages and reply to a message.
- File and image attachments (10 MiB maximum per file) and profile pictures.
- Student search/discovery, profile and settings pages, notifications.
- Admin platform statistics, user account suspension/role management, and user/message reports.
- Unread/read/delivery status, online presence, offline message sync, cross-instance messaging.
- End-to-end encryption enabled by default for newly created conversations (configurable in settings). Existing conversations are not migrated.
- WebRTC DataChannels with Socket.IO signaling and TURN fallback.
- Optional Caddy TLS termination, enabled with the `tls` Compose profile.

## Encryption and deployment notes

Encrypted conversation messages use AES-GCM; conversation keys are wrapped for participants with RSA-OAEP. Encrypted attachments are encrypted in the browser before upload. The API stores encrypted message and attachment bytes, but does not manage or recover private keys.

This is an MVP encryption design, not a security-audited protocol: identity keys and conversation keys are kept in browser local storage, key fingerprints are not independently verified, and there is no device synchronization, key recovery, or forward secrecy. Anyone with script execution in the browser can access keys. Reported encrypted message content is not readable by moderators. Protect the client from XSS and get an independent cryptographic review before relying on E2EE for sensitive communications.

### HTTPS and TURN on a public host

1. Copy `.env.example` to `.env`; replace `JWT_SECRET`, `TURN_SECRET`, and `ADMIN_PASSWORD` with strong unique values.
2. Set `DOMAIN` to a hostname whose DNS points to this host, and set `TURN_URL` to `turn:<public-hostname>:3478?transport=udp`. Set `TURN_REALM` to the TURN hostname.
3. If the host is behind NAT, set `TURN_EXTERNAL_IP` to its public IP. Allow inbound TCP ports 80 and 443, UDP/TCP 3478, and UDP 49160–49200 in the firewall.
4. Start the stack and TLS web service:

   ```sh
   docker compose --profile tls up --build
   ```

Caddy obtains and renews certificates for a public domain. The default `localhost` domain is for local development and uses a locally trusted/self-signed certificate. The TURN service returns short-lived authenticated credentials to signed-in clients; set a unique TURN secret in production.

## Tests

Build the client:

```sh
npm run build --prefix client
```

Database helper unit tests do not require a running stack:

```sh
npm run test:unit --prefix server
```

The server end-to-end and concurrent message tests require `docker compose up` and run with:

```sh
npm install --prefix server
npm test --prefix server
```

Browser-based WebRTC data-channel test:

```sh
npm install --prefix client
npx playwright install chromium
npm run test:webrtc --prefix client
```

## API overview

- `POST /api/auth/register|login`, `GET /api/auth/campuses`
- `GET /api/users?q=`, `GET|POST /api/conversations`
- `GET /api/conversations/:id/messages`, `PATCH|DELETE /api/messages/:id`
- Conversation key envelope endpoints under `/api/conversations/:id/keys`
- `POST /api/conversations/:id/uploads`, `GET /api/uploads/:id`
- Profile, notifications, and reports under `/api/users`, `/api/notifications`, and `/api/reports`
- Admin endpoints under `/api/admin`
