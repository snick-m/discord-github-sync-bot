import express, { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { ManagementStore, Mapping } from "./store";
import { Runtime } from "./runtime";
import { GitHubInstallations } from "./installations";
import { GitHubAccounts } from "./accounts";
import { WebAuth } from "./webAuth";
import { AccessError, UserAccess } from "./userAccess";
import { linkPage } from "./linkPages";
export type UserControl = Pick<
  Runtime,
  | "status"
  | "worker"
  | "reload"
  | "userGuilds"
  | "userChannels"
  | "authorizeForum"
  | "resumeHeld"
>;
export const browserSession = (req: Request) => cookieValue(req, "bridge_user");
export const cookieValue = (req: Request, name: string) =>
  (req.get("cookie") ?? "")
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(name + "="))
    ?.slice(name.length + 1) ?? "";
export function createUserRouter(
  store: ManagementStore,
  runtime: UserControl,
  auth: WebAuth,
  accounts: GitHubAccounts,
  access: UserAccess,
  installations: GitHubInstallations,
) {
  const router = express.Router();
  const guarded =
    (fn: (req: Request, res: Response) => unknown) =>
    (req: Request, res: Response) => {
      Promise.resolve()
        .then(() => fn(req, res))
        .catch((error) => {
          const status = error instanceof AccessError ? error.status : 503;
          res.status(status).json({
            error:
              error instanceof AccessError
                ? error.message
                : "Access check unavailable. Try again or reconnect your accounts.",
          });
        });
    };
  const user = (req: Request) => {
    const result = auth.user(browserSession(req));
    if (!result) throw new AccessError("Sign in with Discord.", 401);
    return result;
  };
  const sessionCookie = (res: Response, token: string) =>
    res.cookie("bridge_user", token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 12 * 3600_000,
    });
  const loginAttempts = new Map<string, { until: number; count: number }>();
  router.get("/auth/discord/login", (req, res) => {
    const socket = req.socket.remoteAddress ?? "unknown";
    const ip = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(socket)
      ? (req.get("cf-connecting-ip") ?? socket)
      : socket;
    const old = loginAttempts.get(ip);
    const attempt =
      old && old.until > Date.now()
        ? old
        : { count: 0, until: Date.now() + 300_000 };
    attempt.count++;
    loginAttempts.set(ip, attempt);
    if (loginAttempts.size > 10000)
      loginAttempts.delete(loginAttempts.keys().next().value!);
    if (attempt.count > 30) {
      res
        .status(429)
        .type("html")
        .send(
          linkPage({
            state: "error",
            message: "Too many sign-in requests. Try again in five minutes.",
          }),
        );
      return;
    }
    try {
      const result = auth.start();
      res.cookie("bridge_discord_oauth", result.browser, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/auth/discord",
        maxAge: 600_000,
      });
      res.redirect(result.url);
    } catch {
      res
        .status(503)
        .type("html")
        .send(
          linkPage({
            state: "error",
            message:
              "Discord sign-in has not been configured. Contact the application administrator.",
          }),
        );
    }
  });
  router.get("/auth/discord/callback", async (req, res) => {
    res.clearCookie("bridge_discord_oauth", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/auth/discord",
    });
    try {
      const result = await auth.callback(
        String(req.query.state ?? ""),
        cookieValue(req, "bridge_discord_oauth"),
        String(req.query.code ?? ""),
        String(req.query.iss ?? ""),
      );
      auth.logout(browserSession(req));
      sessionCookie(res, result.session);
      store.audit(`discord:${result.user.discord}`, "signed in");
      res.redirect(303, "/dashboard");
    } catch {
      res
        .status(400)
        .type("html")
        .send(
          linkPage({
            state: "error",
            message:
              "Discord sign-in could not be verified. Return to the dashboard and sign in again.",
          }),
        );
    }
  });
  router.use("/user-api", express.json({ limit: "16kb" }));
  router.get("/user-api/session", (req, res) => {
    const profile = auth.user(browserSession(req));
    res.json({
      authenticated: Boolean(profile),
      user: profile,
      csrf: profile ? auth.csrf(browserSession(req)) : undefined,
      loginReady: auth.config().configured,
    });
  });
  router.use("/user-api", (req, res, next) => {
    if (!auth.user(browserSession(req))) {
      res.status(401).json({ error: "Sign in with Discord." });
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.get("origin");
      let cross = false;
      if (origin && origin !== "null") {
        try {
          const url = new URL(origin);
          cross =
            url.host !== req.get("host") ||
            !["http:", "https:"].includes(url.protocol);
        } catch {
          cross = true;
        }
      }
      if (
        cross ||
        !req.is("application/json") ||
        !auth.verifyCsrf(browserSession(req), req.get("x-csrf-token") ?? "")
      ) {
        res.status(403).json({
          error: "Request could not be verified. Reload the dashboard.",
        });
        return;
      }
    }
    next();
  });
  const authorize = async (discord: string, mapping: Mapping) => {
    const forum = await runtime
      .authorizeForum(discord, mapping.channel)
      .catch(() => {
        throw new AccessError("Manage Server and forum access are required.");
      });
    if (mapping.guildId && forum.guildId !== mapping.guildId)
      throw new AccessError("The destination server changed.");
    const repo = await access.authorize(
      discord,
      `${mapping.owner}/${mapping.repo}`,
      mapping.installation,
    );
    if (mapping.repositoryId && repo.id !== mapping.repositoryId)
      throw new AccessError(
        "Repository identity changed. Contact an administrator.",
      );
    return { forum, repo };
  };
  const visible = async (discord: string) => {
    const guilds = await runtime.userGuilds(discord);
    const ids = new Set(guilds.map((g) => g.id));
    const result: Mapping[] = [];
    const candidates = store
      .mappings()
      .filter((m) => !m.guildId || ids.has(m.guildId));
    for (let offset = 0; offset < candidates.length; offset += 4) {
      const entries = await Promise.all(
        candidates.slice(offset, offset + 4).map(async (mapping) => {
          try {
            await authorize(discord, mapping);
            return mapping;
          } catch {
            return undefined;
          }
        }),
      );
      for (const mapping of entries) if (mapping) result.push(mapping);
    }
    return result;
  };
  router.get(
    "/user-api/state",
    guarded(async (req, res) => {
      const profile = user(req),
        link = accounts.link(profile.discord);
      const mappings =
        link?.status === "active" ? await visible(profile.discord) : [];
      const ids = new Set(mappings.map((m) => m.id));
      const status = runtime.status();
      res.json({
        user: profile,
        github: link ? { login: link.login, status: link.status } : undefined,
        pending: accounts.pending(profile.discord),
        installUrl: accounts.app().slug
          ? `https://github.com/apps/${accounts.app().slug}/installations/new`
          : undefined,
        botReady: status.discord.connected,
        serviceReady: installations.config().configured,
        mappings: status.mappings
          .filter((m) => ids.has(m.id))
          .map((m) => ({
            id: m.id,
            owner: m.owner,
            repo: m.repo,
            channel: m.channel,
            channelName: m.channelName,
            enabled: m.enabled,
            ready: m.ready,
            pending: m.pending,
            failed: m.failed,
            blocked: m.blocked,
            error: m.error,
          })),
        activity: store
          .activity()
          .filter((a) => ids.has(String(a.mapping)))
          .map((a) => ({
            at: a.at,
            action: a.action,
            repository: a.repository,
            actor: a.actor,
          })),
        inviteUrl: status.discord.id
          ? `https://discord.com/oauth2/authorize?client_id=${status.discord.id}&scope=bot%20applications.commands&permissions=292057844736`
          : undefined,
      });
    }),
  );
  router.post(
    "/user-api/logout",
    guarded((req, res) => {
      auth.logout(browserSession(req));
      res.clearCookie("bridge_user", {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
      });
      res.json({ ok: true });
    }),
  );
  router.post(
    "/user-api/github/link",
    guarded((req, res) => res.json({ url: accounts.begin(user(req).discord) })),
  );
  router.post(
    "/user-api/github/confirm",
    guarded((req, res) => {
      const profile = user(req);
      const pending = accounts.pending(profile.discord);
      if (!pending || pending.id !== req.body.id)
        throw new AccessError(
          "No matching GitHub authorization waiting for confirmation.",
          400,
        );
      const link = accounts.confirm(profile.discord, pending.id);
      store.audit(`discord:${profile.discord}`, "linked GitHub");
      runtime.resumeHeld();
      res.json({ ok: true, login: link.login });
    }),
  );
  router.post(
    "/user-api/github/unlink",
    guarded((req, res) => {
      const profile = user(req);
      accounts.unlink(profile.discord);
      store.audit(`discord:${profile.discord}`, "unlinked GitHub");
      res.json({ ok: true });
    }),
  );
  router.get(
    "/user-api/installations",
    guarded(async (req, res) =>
      res.json({
        installations: await access.installations(user(req).discord),
      }),
    ),
  );
  router.get(
    "/user-api/repositories",
    guarded(async (req, res) =>
      res.json({
        repositories: await access.repositories(
          user(req).discord,
          Number(req.query.installation),
        ),
      }),
    ),
  );
  router.get(
    "/user-api/guilds",
    guarded(async (req, res) =>
      res.json({ guilds: await runtime.userGuilds(user(req).discord) }),
    ),
  );
  router.get(
    "/user-api/channels",
    guarded(async (req, res) => {
      const guild = String(req.query.guild ?? "");
      if (!/^\d{5,25}$/.test(guild))
        throw new AccessError("Select a server.", 400);
      try {
        res.json({
          channels: await runtime.userChannels(user(req).discord, guild),
        });
      } catch {
        throw new AccessError("Manage Server permission is required.");
      }
    }),
  );
  router.post(
    "/user-api/mappings",
    guarded(async (req, res) => {
      if (!installations.config().configured)
        throw new AccessError(
          "Repository sync requires administrator setup.",
          503,
        );
      const profile = user(req),
        fullName = req.body.repository,
        channel = req.body.channel;
      if (
        typeof fullName !== "string" ||
        typeof channel !== "string" ||
        typeof req.body.backfill !== "boolean"
      )
        throw new AccessError("Select a repository and forum.", 400);
      const repo = await access.repository(
        profile.discord,
        Number(req.body.installation),
        fullName,
      );
      let forum;
      try {
        forum = await runtime.authorizeForum(profile.discord, channel);
      } catch {
        throw new AccessError(
          "Manage Server, forum visibility, and the bot's forum permissions are required.",
        );
      }
      if (
        store
          .mappings()
          .some(
            (m) =>
              m.channel === channel ||
              `${m.owner}/${m.repo}`.toLowerCase() ===
                repo.fullName.toLowerCase(),
          )
      )
        throw new AccessError(
          "That repository or forum already has a mapping.",
          409,
        );
      const [owner, name] = repo.fullName.split("/");
      const mapping: Mapping = {
        id: randomUUID(),
        owner,
        repo: name,
        channel,
        backfill: req.body.backfill,
        enabled: true,
        roles: [],
        installation: repo.installation,
        repositoryId: repo.id,
        guildId: forum.guildId,
        createdBy: profile.discord,
      };
      store.saveMapping(mapping);
      store.audit(`discord:${profile.discord}`, "created mapping", mapping);
      void runtime.reload();
      res.status(201).json({ ok: true });
    }),
  );
  router.post(
    "/user-api/mappings/:id/:action?",
    guarded(async (req, res) => {
      const profile = user(req),
        mapping = store.mapping(String(req.params.id));
      if (!mapping) throw new AccessError("Mapping unavailable.", 404);
      const scope = await authorize(profile.discord, mapping);
      if (!mapping.repositoryId || !mapping.installation || !mapping.guildId) {
        mapping.repositoryId = scope.repo.id;
        mapping.installation = scope.repo.installation;
        mapping.guildId = scope.forum.guildId;
        store.saveMapping(mapping);
        void runtime.reload();
      }
      const action = req.params.action;
      if (!action) {
        if (typeof req.body.enabled !== "boolean")
          throw new AccessError("Invalid mapping state.", 400);
        store.saveMapping({ ...mapping, enabled: req.body.enabled });
        store.audit(
          `discord:${profile.discord}`,
          req.body.enabled ? "resumed mapping" : "paused mapping",
          mapping,
        );
        void runtime.reload();
      } else if (action === "scan" || action === "retry") {
        const worker = runtime.worker(mapping.id);
        if (!worker) throw new AccessError("Mapping is initializing.", 503);
        if (action === "scan")
          worker.store.enqueue({ type: "scan" }, randomUUID());
        else {
          worker.store.db.exec(
            "UPDATE jobs SET attempts=0,failed=0,next_at=0,error=NULL WHERE failed=1",
          );
          worker.store.enqueue({ type: "scan" }, randomUUID());
        }
        store.audit(
          `discord:${profile.discord}`,
          action === "scan" ? "queued scan" : "retried changes",
          mapping,
        );
      } else throw new AccessError("Unknown mapping action.", 404);
      res.json({ ok: true });
    }),
  );
  return router;
}
