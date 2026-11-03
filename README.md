# GitHub Issues ↔ Discord forum sync

A self-hosted bridge for one GitHub repository and one Discord forum channel. Run one bot instance on your homeserver with Docker Compose. Based on [Sillhouette/discord-github-sync-bot](https://github.com/Sillhouette/discord-github-sync-bot), originally by [holmityd](https://github.com/holmityd/GitHub-Issues-Discord-Threads-Bot). MIT licensed; original credits retained in LICENSE.

This fork replaces the upstream in-memory sync runtime with a SQLite-backed engine while retaining TypeScript, discord.js, Octokit, Express, webhook signature verification, and the R2 uploader.

## What syncs

- New GitHub issues create forum posts. Human-created forum posts create GitHub issues.
- Replies sync both ways with attribution and source links. Bot/webhook-authored Discord messages are excluded to prevent loops.
- GitHub title, body, labels, lock state, and open/closed state update the Discord thread and a bot-owned summary. Matching label names become forum tags (at most five).
- For a Discord-origin issue, editing the original Discord starter updates its GitHub body. Other issue metadata is managed on GitHub after creation; later Discord title/tag changes are not sent upstream.
- Discord-origin replies are editable from Discord; GitHub-origin replies are editable from GitHub. Editing the mirrored copy does not change its source.
- Long GitHub content is split across messages with a source link in every part. Shortened content leaves a placeholder in obsolete parts.
- Deleted source comments/messages become a deletion notice in their mirrors. Deleting an entire thread or issue **disables its mapping**; it does not delete the other side or recreate the deleted object.
- All outbound Discord messages disable mentions, including edits.

**Archiving is not issue closure.** Discord automatically archives inactive posts. This never closes or reopens a GitHub issue. Use the commands below for deliberate status changes.

## Homeserver setup

### 1. Create a Discord bot and a dedicated forum

In the [Discord Developer Portal](https://discord.com/developers/applications), create an application and bot, copy its token, and enable **Message Content Intent**. Invite it using the `bot` and `applications.commands` scopes.

Give the bot these permissions in your forum:

- View Channel
- Send Messages (needed to create forum posts)
- Send Messages in Threads
- Read Message History
- Manage Threads

It does not need Administrator, Manage Messages, Manage Webhooks, Presence Intent, or Members Intent. Permissions and the forum type are checked at startup. Use a forum without a required-tag policy, or ensure every mirrored issue has a label matching an available forum tag. Obtain the forum channel ID using Discord Developer Mode.

Everything humans write in this forum is eligible for copying to GitHub. Choose the repository and forum audience accordingly.

### 2. Create GitHub credentials

Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) scoped to the target repository, with **Issues: read and write** and the default Metadata access. Approve the token in your organization if required. Track its expiration and rotate it in `.env` before it expires.

This version uses a PAT, not a GitHub App. GitHub issues/comments appear under the PAT account, with the Discord author credited in the body. Pull requests are excluded.

### 3. Configure and start

```sh
git clone https://github.com/snick-m/discord-github-sync-bot.git
cd discord-github-sync-bot
cp .env.example .env
chmod 600 .env
```

Fill in the six required values in `.env`: `DISCORD_TOKEN`, `DISCORD_CHANNEL_ID`, `GITHUB_ACCESS_TOKEN`, `GITHUB_USERNAME`, `GITHUB_REPOSITORY`, and `GITHUB_WEBHOOK_SECRET`. `GITHUB_USERNAME` is the repository owner (user or organization); `GITHUB_REPOSITORY` is its name without the owner.

Choose a random webhook secret, for example by running `openssl rand -hex 32`, and enter that value in both `.env` and GitHub. Never commit `.env` or put secrets in webhook URLs.

Defaults import items created from the first start onward. Set `BACKFILL=open` before starting to also import existing open issues and active human-created forum posts. That can create many objects; use a dedicated forum. Items created during later downtime are recovered even with `BACKFILL=none`.

```sh
docker compose up -d --build
docker compose logs -f bot
curl --fail http://127.0.0.1:5000/health
```

Wait for `Ready: owner/repository ↔ forum ...`. Health returns 503 until Discord connects and startup checks finish. SQLite lives in the named `bot-data` volume. **Do not use `docker compose down -v` unless you intend to erase mappings and pending jobs.** Run only one bot instance against a database.

### 4. Expose the GitHub webhook

The bot is published only on `127.0.0.1:5000` by default. Use an existing HTTPS reverse proxy or a Cloudflare Tunnel running on the host, forwarding to `http://127.0.0.1:5000`. If your tunnel/proxy is another container, join the same Docker network and use `http://bot:5000` instead of localhost.

The bot process runs on your server; a tunnel does not run it inside a Cloudflare Worker. Forward only `/github-webhook` if your proxy supports path restrictions.

In the target GitHub repository, go to **Settings → Webhooks → Add webhook**:

- Payload URL: `https://your-bot-domain.example/github-webhook`
- Content type: `application/json`
- Secret: the exact `GITHUB_WEBHOOK_SECRET` value
- Individual events: **Issues** and **Issue comments**
- Keep SSL verification enabled.

A successful ping returns HTTP 200. Valid issue deliveries return 202 after they have been committed to SQLite. Root POST `/` remains a compatibility alias.

### 5. Smoke-test your installation

1. Create a GitHub issue. Check that one Discord post appears with its source link.
2. Reply on each side and verify the replies arrive once. Edit each original reply and verify its mirror updates.
3. Create a forum post and verify one GitHub issue appears.
4. Restart the bot with `docker compose restart bot`, then add another reply on each side. Verify the existing mappings still work.
5. Archive a thread manually. Its GitHub issue must remain open.
6. Close and reopen through `/issue` and GitHub. Verify the summary and archived state update.

These live checks require real credentials. Automated tests use fakes and do not post to either service.

## Commands

The bot registers a guild-scoped `/issue` command automatically:

- `/issue status` — show the linked issue.
- `/issue close` — close it on GitHub and archive its thread.
- `/issue reopen` — reopen it.

Inside a synced thread, the issue is inferred. Supply `number:123` from another channel in the same server when the thread is archived. You must have access to the forum. Close/reopen additionally require **Manage Threads in the forum**, or one of the comma-separated `MANAGER_ROLE_IDS`. The command acknowledges a durable job; API failures are retried and visible in logs/queue status.

## Reliability and operations

The engine runs one durable job at a time. Webhook delivery IDs are deduplicated; message mappings and content hashes suppress echoes. Source markers and bot-authored message history let retries recover remote writes whose responses were lost. Cross-service writes cannot be a single transaction, so this is recoverable synchronization, not a distributed exactly-once guarantee.

A recovery scan runs on startup, after a resumed Discord connection, and every `RECONCILE_SECONDS` (default 300, minimum 60). It scans updated GitHub issues, all mapped issues/comments, and active/archived forum posts and their message histories. This recovers missed creates, edits, and deletions. It is intended for a modest-volume single repo/forum; large archives require incremental history indexing before scaling up.

Failed jobs retry with exponential backoff and respect GitHub rate-limit headers. After ten failures, a job is retained as failed and other work can proceed. Fix the underlying permission/configuration/API problem, then retry it:

```sh
docker compose exec bot node dist/queue.js status
docker compose exec bot node dist/queue.js retry JOB_ID
docker compose exec bot node dist/queue.js retry all
```

`GET /health` reports Discord readiness, pending/failed job counts, and maximum attempts. Docker health status alone does not restart an unhealthy container; process exits are restarted by Compose. Monitor logs and failed jobs. HTTP 404 on a mapped issue/thread disables the mapping to avoid unwanted recreation; transient network errors and 403s are retried.

Back up the SQLite volume while the bot is stopped, including the database, `-wal`, and `-shm` files if present:

```sh
docker compose stop bot
# Use your normal Docker volume backup procedure for this project's bot-data volume.
docker compose start bot
```

The database is bound to its repository/forum configuration. For a different pairing, use a separate Compose project and volume. Existing upstream `commentMap.json` data is not automatically migrated; this fork is designed for a fresh installation. Old upstream deployment scripts/docs under `docs/` are historical, not instructions for this runtime.

To update:

```sh
git pull --ff-only
docker compose up -d --build
```

Back up before upgrading or rolling back. Keep the previous Git commit/image until the new version passes your smoke tests.

## Attachments

Without optional R2 configuration, copied Discord attachment URLs can expire. Set all four R2 variables in `.env` to rehost files in your bucket with a public HTTPS base URL. Use a Cloudflare API token authorized for uploading objects to that bucket. Rehosted files are capped at 20 MiB each; oversized files fail their job rather than silently disappearing. R2 storage/API usage is separate from hosting the bot.

Deleting a source message does not remove an already rehosted object; manage storage retention separately. Signed links to private GitHub attachments may also expire or be inaccessible in Discord.

## Local development

Requires Node.js 24+ (built-in SQLite) and pnpm 8.6.3.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
pnpm dev
```

Tests cover lost API responses, restart persistence, bidirectional edits, echo prevention, long messages, safe deletion behavior, recovery imports, signed webhook intake, durable retries, and configuration validation. CI runs type checking, tests, the build, a Docker build, and credential-free startup smoke checks.
