# CopyPastePyon

**Copy. Paste. Connect.** A lightweight, self-hosted shared code workspace for moving code between your devices or sharing it with collaborators through a temporary eight-character workspace code.

## What it does

- Create a secure, temporary workspace without an account.
- Join with a workspace code and an optional display name.
- Create, edit, search, sort, delete, format, and copy multiple code notes.
- Synchronize note changes and connected-user presence in real time with Socket.IO.
- Use collaborative or view-only access; hosts can change access, remove participants, regenerate the code, and end sharing immediately.
- Protect edits with note versions so a stale editor is warned before overwriting a newer change.
- Keep formatting opt-in and preview-only until the note is saved.
- Work well on desktop and mobile, with remembered dark/light mode.

CopyPastePyon stores and displays submitted code as text only. It never executes user code.

## Technology

- Node.js 24+ with Express and Socket.IO
- SQLite through Node's built-in `node:sqlite` module (no native database package required)
- A dependency-light, responsive vanilla JavaScript client
- Prettier for safe formatting of JavaScript, TypeScript, JSON, HTML, CSS, and Markdown

The intentionally compact stack makes the project straightforward to understand and self-host. SQLite is ideal for one-server deployments; use a managed database and a Socket.IO adapter if scaling to multiple application instances.

## Requirements

- Node.js 24 or newer (required for `node:sqlite`)
- npm

## Local development

```bash
git clone <your-repository-url>
cd CopyPastePyon
copy .env.example .env
npm install
npm run dev
```

Open `http://localhost:3000`. `npm start` runs the normal server and `npm test` runs API, Socket.IO, browser workflow, and baseline accessibility checks. The browser test uses installed Chrome on Windows; on Linux/macOS, install Playwright Chromium with `npx playwright install chromium` first.

## Environment configuration

Copy `.env.example` to `.env`; do not commit `.env`.

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP/WebSocket port | `3000` |
| `DATABASE_URL` | SQLite database file path | `./data/copypastepyon.db` |
| `SESSION_SECRET` | Reserved secret for future signed-cookie integrations | set a strong production value |
| `WORKSPACE_EXPIRATION_HOURS` | Temporary workspace lifetime (1–168 hours) | `24` |
| `MAX_NOTE_SIZE` | Maximum note content size in bytes | `200000` |
| `RATE_LIMIT` | Join attempts per IP in 15 minutes | `30` |
| `NODE_ENV` | Runtime environment | `development` |

The database schema is initialized on application startup. For a clean local reset, stop the server and remove only `data/copypastepyon.db` (and its SQLite journal files).

## Production deployment

1. Set a production `.env`, especially `SESSION_SECRET`, `DATABASE_URL`, and expiration limits.
2. Run behind an HTTPS reverse proxy such as Caddy or Nginx. Proxy WebSocket upgrade requests as well as normal HTTP traffic.
3. Serve only through HTTPS so the browser Clipboard API and Socket.IO use secure contexts/WSS.
4. Persist and back up the SQLite data directory. For multiple server processes, move persistence to PostgreSQL and configure a shared Socket.IO adapter before load balancing.
5. Run with a service manager (systemd, Docker, or your hosting platform) using `npm start`.

## InfinityFree deployment

InfinityFree cannot run the Node.js/Socket.IO server. This repository includes a safe PHP/MySQL target for that host without changing the Node deployment:

1. In `public/api`, copy `config.example.php` to `config.php` and enter the MySQL credentials from InfinityFree. Set a new, long random `app_secret`; do not use an account password.
2. Upload the **contents** of `public` to the domain's `htdocs` directory, including `.htaccess` and `api/`.
3. Confirm the MySQL database is empty or dedicated to this app; the PHP API creates its tables on first use.
4. Visit the domain, create a workspace, then open the share link in a separate browser window and confirm notes save correctly.

The InfinityFree target uses short polling for updates and approximate activity presence because free hosting does not support Socket.IO/WebSockets. It preserves code in the format preview rather than running a server-side formatter. Use the Node deployment for full real-time sync and formatting.

## API overview

Workspace endpoints are under `/api/workspaces`: create, join, inspect, settings, regenerate code, and close. Notes are nested beneath their workspace and require an `X-Session-Token` issued by host/join. The token is generated cryptographically and scoped to one workspace. Socket events cover `note:created`, `note:updated`, `note:deleted`, `workspace:users_changed`, permission changes, code regeneration, and closure.

## Security notes

- Workspace codes and connection tokens use cryptographic randomness.
- Server-side session and role checks protect all workspace/note operations.
- Join attempts are rate-limited and input sizes/languages are validated.
- User text is escaped before it is rendered; submitted code is never executed.
- Expired, closed, and host-removed sessions reject new API and WebSocket connections; active sockets are disconnected immediately.
- Use HTTPS/WSS in production. The workspace code is an access key, so share it only with intended collaborators.

## Limitations and roadmap

This MVP uses version checking rather than Google Docs-style simultaneous editing. If someone saves a newer version while another person is editing, the stale editor gets a reload option. Formatting is deliberately available only for formats Prettier can safely parse in this application; unsupported languages retain their original text.

## Contributing

Open an issue describing the change, keep pull requests focused, add or update tests for backend behavior, and run `npm test` before submitting. Do not commit credentials, database files, or generated dependencies.

## License

MIT. See [LICENSE](LICENSE).
