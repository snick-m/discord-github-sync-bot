# Issue Bridge

A self-hosted GitHub Issues ↔ Discord forum bridge with a management page. Configure a GitHub App once, then map each repository to its own Discord forum. Configuration changes apply without restarting the service.

Based on [Sillhouette/discord-github-sync-bot](https://github.com/Sillhouette/discord-github-sync-bot), originally by [holmityd](https://github.com/holmityd/GitHub-Issues-Discord-Threads-Bot). MIT; original credits are retained in LICENSE.

## Manage through the web page

- Connect one Discord bot and choose its available forum channels from a dropdown.
- Discover GitHub App installations and the repositories each account has approved.
- Map repositories to forums, choose whether to import existing items, and configure manager roles per mapping.
- Pause/resume mappings, queue recovery scans, inspect queue counts, and retry failed changes.
- Rotate the App private key without changing mappings or editing `.env`.
- Receive repository or organization webhooks at one shared `/github-webhook` endpoint.

The application starts with an **empty `.env`**. The Discord bot token, GitHub App credentials, and repository mappings belong in the management UI. Environment variables now configure only deployment options such as the public URL, ports, storage, and optional R2 uploads.

## GitHub account linking (required for Discord writes)

Register a GitHub App under your organization or account and install it on the selected repositories:

- Homepage: your public bridge URL.
- User authorization callback: `https://gitissues.rmush.dev/auth/github/callback` (replace the hostname for another deployment).
- Repository permissions: **Issues: read and write**, Metadata: read.
- Enable expiring user access tokens. Leave authorization during installation and Device Flow disabled; members initiate authorization through Discord.
- Webhook URL: the dashboard’s `/github-webhook` URL, with the same shared webhook secret configured in the dashboard. Authorization revocation events invalidate linked tokens; Issues and Issue comments events can also use this endpoint.

Enter the App’s **client ID**, **slug**, and **client secret** in the dashboard’s account-linking section. The secret and member tokens are encrypted at rest and never returned by the API. Changing the client ID requires members to authorize again.

Each member runs `/github link`, opens the private single-use URL, clicks **Continue to GitHub**, authorizes on GitHub, then runs `/github confirm` and confirms the displayed GitHub account in Discord. `/github status` shows their link; `/github unlink` deletes their local tokens and pending authorizations. Members can also revoke access in GitHub settings. A GitHub identity may be linked to only one Discord identity.

**There is no shared-token fallback for Discord → GitHub.** New issues, comments, edits, deletion tombstones, and close/reopen actions require the appropriate linked user token and GitHub permissions. Expired, revoked, missing, or unauthorized credentials hold the change. Messages remain in Discord, recent messages get a rate-limited linking notice, and held counts appear in the dashboard. Linking triggers a recovery scan; only surviving source messages are sent. GitHub → Discord continues for GitHub contributors without Discord links. Reactions are not synced.

Writes appear as the actual GitHub user (with GitHub’s app attribution).

## GitHub App installation access (required for repository reads)

In your GitHub App settings, find the numeric **App ID**, then generate and download an RSA private key under **Private keys**. In the dashboard, first save the app’s client ID, slug, and client secret, then enter its App ID and paste the PEM private key into **App installation access**. The server validates that the ID and key belong to the same app as the saved client settings. The key is encrypted and never returned by the API.

Install this app on each organization or personal account you want to sync, selecting its approved repositories. Refresh installations in the dashboard, select the account installation and repository, then choose a Discord forum. Organization approval and repository access are controlled by the GitHub App installation. Another organization does not need to supply a PAT or create a separate GitHub App; its administrator installs this app, and this instance’s administrator configures its mappings.

Repository discovery and GitHub → Discord reads use installation tokens restricted to **Issues: read** and **Metadata: read**. Sync tokens are additionally restricted to the single mapped repository. Tokens stay in memory, expire after an hour, and refresh automatically. A rejected token is refreshed once; missing installations, suspended accounts, or revoked repository access fail closed. Installation permission changes trigger a reconnect through the webhook.

**Personal access tokens are not supported.** The PAT UI, API, environment import, and stored PATs are removed. Existing mapping identities, queues, and message history are retained. Reads pause until the App ID and private key are configured. Discord-originated writes always require the member’s linked GitHub authorization and never use the installation token.

## Initial administrator setup

There is no default administrator password. The simplest setup is to set `ADMIN_PASSWORD` in `.env` (12–256 characters), restart the application, and sign in directly through your normal HTTPS hostname. In the deployed LXC, edit `/etc/discord-github-sync/.env` and run `systemctl restart discord-github-sync`.

`ADMIN_PASSWORD` initializes the first administrator only. Once an account exists, the variable is ignored and cannot silently change its password on later restarts. The application stores only the password hash. After successful setup, remove the plaintext value from `.env`; the account continues to work. For a deliberate password reset, use the CLI described below.

If you leave `ADMIN_PASSWORD` unset, private browser setup remains available. Public first-time registration is always disabled.

To use the optional private browser setup in the deployed Proxmox LXC, forward its setup port from your own computer:

```sh
ssh -N -J root@server -L 5001:127.0.0.1:5001 root@10.20.84.190
```

Keep that command running and open **http://localhost:5001** in your browser. Create a password of at least 12 characters. You can then close the tunnel and sign in at **https://gitissues.rmush.dev**. These addresses describe this installation; use your own SSH host and public hostname for another deployment.

For Docker, the setup listener remains private inside the container. Create the first administrator interactively instead:

```sh
docker compose exec bot node dist/admin.js setup
```

Input is hidden. Then open the dashboard through your HTTPS reverse proxy, or through its loopback-published host port for local use.

Sessions expire after 12 hours. The web API requires authentication and same-origin mutation requests, and login attempts are rate limited. Public sessions use Secure, HttpOnly, SameSite cookies. The setup listener checks localhost hostnames in addition to binding loopback. Do not expose port 5001 through a reverse proxy or tunnel.

To recover a forgotten password, run `node dist/admin.js reset` interactively as the service user with the correct `DATA_DIR`; this invalidates all existing sessions. In Docker, use `docker compose exec bot node dist/admin.js reset`.

## Connect Discord

In the [Discord Developer Portal](https://discord.com/developers/applications), create a bot and enable **Message Content Intent**. Invite it to your server with the `bot` and `applications.commands` scopes.

For every mapped forum, grant the bot:

- View Channel
- Send Messages
- Send Messages in Threads
- Read Message History
- Manage Threads

The bot does not need Administrator, Manage Messages, Manage Webhooks, Presence Intent, or Members Intent. Use forum channels without required tags, or ensure every incoming issue has a label matching an available forum tag.

Enter the bot token in **Your Discord bot** in the management page. After it connects, refresh channels, configure installation access, and create a mapping. Each repository and each forum can belong to only one saved mapping, including paused mappings. Repository and forum cannot be changed in place because existing issue/thread identities must stay stable; private-key rotation and pause/resume preserve their history.

The forum is a publishing boundary: human-created posts and replies are eligible for copying to its mapped GitHub repository. Choose the audience accordingly.

## Sync behavior

- New GitHub issues create forum posts. Human-created forum posts create GitHub issues.
- Replies sync both ways with attribution and source links; Discord bot/webhook messages are excluded.
- Edit the original reply on its source platform to update its mirror.
- GitHub title, body, labels, lock state, and open/closed state update the forum thread and bot-owned summary. Matching label names become forum tags, up to five.
- For Discord-origin issues, editing the original starter updates its GitHub body. Other metadata is managed on GitHub after creation; later Discord title/tag changes do not change GitHub.
- Long GitHub content is split across messages. Shortening content leaves placeholders in obsolete parts.
- Deleted source comments/messages become deletion notices in their mirrors. Deleting an entire thread/issue disables its mapping; it does not delete its counterpart or recreate the removed object.
- Outbound Discord messages disable mentions, including edits.

**Archiving is not closure.** Inactivity auto-archive never changes GitHub state. Use `/issue close` or `/issue reopen`. Inside a synced thread the repository is inferred; elsewhere specify `repository:owner/repo` and `number:123` when multiple repositories are mapped. Close/reopen require a linked GitHub account with repository permission, plus access to the forum and Manage Threads there or one of its configured manager roles. `/issue status` shows the linked issue.

## Webhooks and polling

Polling works without public ingress or a webhook secret. A recovery scan runs on startup, after Discord resumes a connection, and every `RECONCILE_SECONDS` (default 300, minimum 60).

For immediate GitHub updates, save a shared webhook secret in the management page and enable the GitHub App webhook:

- URL: `https://YOUR_HOST/github-webhook`
- Content type: `application/json`
- Secret: the same value you entered in the management page
- Events: **Issues** and **Issue comments**

Unmapped repositories cannot create work. Events are routed by full repository name and committed to that mapping's durable queue before acknowledgement. Pull requests are excluded. Pings return 200; accepted issue changes return 202. Paused mappings acknowledge events without processing them; recovery scans reconcile current state on resume.

With the deployed Cloudflare Tunnel, the public hostname is `gitissues.rmush.dev` and `cloudflared` runs in LXC 109. The application requires `PUBLIC_URL=https://gitissues.rmush.dev` in the service environment. The tunnel forwards the dashboard, its assets/API, and the webhook to `http://127.0.0.1:5000`; authentication protects management routes. The private setup port is never forwarded. Avoid Cloudflare Access login or browser challenges on `/github-webhook`, since GitHub cannot complete those interactions.

## Deployment

Requires Node.js 24+ with built-in SQLite. Run one application instance per data directory.

```sh
git clone https://github.com/snick-m/discord-github-sync-bot.git
cd discord-github-sync-bot
touch .env
# Set PUBLIC_URL to your HTTPS origin if using a public hostname.
docker compose up -d --build
```

Compose publishes port 5000 only on the host's loopback interface and stores data in `bot-data`. An HTTPS reverse proxy or Cloudflare Tunnel can forward to that port. A containerized proxy must join the same network and use `http://bot:5000`.

For the native LXC installation:

- App: `/opt/discord-github-sync`
- Optional environment file: `/etc/discord-github-sync/.env` (the app's `.env` is a symlink)
- State: `/var/lib/discord-github-sync`
- Service: `discord-github-sync.service`, running as `gdsync`
- Public port: 5000; private initial setup port: 5001

```sh
systemctl status discord-github-sync
journalctl -u discord-github-sync -f
curl --fail http://127.0.0.1:5000/health
```

Health indicates the management process is available, even before Discord is configured. The dashboard reports Discord connection and individual mapping errors separately. Configuration changes finish any currently running sync job before applying the new connection state; a paused mapping keeps its history and pending jobs.

## State, recovery, and backups

`management.sqlite` holds encrypted credentials, mappings, administrator password hashes, and hashed sessions. Credentials use AES-256-GCM with the separate `master.key` file. Tokens are write-only through the web API and are not returned to the browser. Host access to both the database and key allows credential recovery, so restrict and protect backups.

Each mapping has its own `routes/<mapping-id>.sqlite` with issue/thread links, comment/message links, delivery deduplication, and retry jobs. Issue numbers therefore never collide across repositories. Mapping state files remain at their existing paths across deployment updates. Environment configuration is not imported into application credentials.

Back up the **whole data directory**, including `master.key`, while the service is stopped. Preserve any SQLite `-wal` and `-shm` files present. Losing the key makes saved credentials unusable; the application refuses to silently replace a missing key when encrypted credentials exist. `docker compose down -v` erases state and should not be used during normal updates.

The engine uses durable queues, source markers, and remote message history to recover interrupted writes. Cross-service writes are not a distributed exactly-once transaction. Recovery scans enumerate mapped issue/comment histories and active/archived forum threads; this is intended for a modest-volume self-hosted installation rather than very large community archives.

One mapping's failed job does not block other mappings. Jobs retry with backoff and respect GitHub rate-limit headers; after ten failures they remain available for inspection and manual retry in the dashboard. Command-line equivalents:

```sh
pnpm queue list
pnpm queue owner/repo status
pnpm queue owner/repo retry all
```

For CLI tools in the LXC, run as `gdsync` with `DATA_DIR=/var/lib/discord-github-sync` and the absolute Node path `/usr/local/bin/node` if it is absent from the shell's PATH.

## Attachments

Without optional R2 configuration, copied Discord attachment URLs can expire. Set all four R2 variables in `.env` to rehost files in your bucket with a public HTTPS base URL. Uploads are capped at 20 MiB per file. Deleting a source does not delete rehosted objects; manage retention separately. Private GitHub attachment links may also expire or be inaccessible in Discord.

## Development

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
pnpm dev
```

Tests cover durable recovery, edits, echo prevention, safe deletion, queue persistence, repository isolation, webhook routing, administrator bootstrap restrictions, session/CSRF protection, encrypted credential storage, installation-token rotation and scope restriction. CI also builds and smoke-tests the production Docker image. Live Discord/GitHub tests require your real credentials and chosen mappings.
