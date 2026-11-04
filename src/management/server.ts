import express, { Request, Response } from "express";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { ManagementStore } from "./store";
import { Runtime } from "./runtime";
import { validateDiscord } from "./providers";
import { verifySignature } from "../webhookSignature";
import { linkPage, linkCss } from "./linkPages";
import { createUserRouter, browserSession, UserControl } from "./userServer";
import { WebAuth } from "./webAuth";
import { UserAccess } from "./userAccess";
import { html, userHtml, css, js } from "./ui";

import { GitHubInstallations } from "./installations";
import { GitHubAccounts } from "./accounts";

class PublicError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
interface Options {
  bootstrap: boolean;
  webAuth?: WebAuth;
  userAccess?: UserAccess;
  accounts?: GitHubAccounts;
  installations?: GitHubInstallations;
  publicUrl?: string;
}
export type Control = Pick<
  Runtime,
  | "status"
  | "channels"
  | "reload"
  | "worker"
  | "userGuilds"
  | "userChannels"
  | "authorizeForum"
  | "resumeHeld"
>;
const loopback = (host: string) =>
  host === "localhost" || host === "127.0.0.1" || host === "[::1]";
const field = (
  body: Record<string, unknown>,
  key: string,
  optional = false,
  max = 100,
  trim = true,
) => {
  const value = body[key];
  if (optional && (value === undefined || value === "")) return "";
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new PublicError(`Invalid ${key}.`);
  return trim ? value.trim() : value;
};
const roles = (value: unknown) => {
  if (value === undefined || value === "") return [];
  if (typeof value !== "string" || value.length > 2000)
    throw new PublicError("Invalid manager role IDs.");
  const ids = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.some((id) => !/^\d{5,25}$/.test(id)))
    throw new PublicError("Role IDs must be comma-separated Discord IDs.");
  return [...new Set(ids)];
};
export function createManagementServer(
  store: ManagementStore,
  runtime: Control,
  options: Options,
  providers = { validateDiscord },
) {
  const app = express();
  app.disable("x-powered-by");
  const allowedPublicHost = options.publicUrl
    ? new URL(options.publicUrl).host
    : undefined;
  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'${!options.bootstrap && req.path === "/auth/github/start" ? " https://github.com/login/oauth/authorize" : ""}; base-uri 'none'; frame-ancestors 'none'`,
    });
    if (options.bootstrap && !loopback(req.hostname)) {
      res.status(403).json({
        error: "Setup is available only on localhost through an SSH tunnel.",
      });
      return;
    }
    if (
      !options.bootstrap &&
      allowedPublicHost &&
      req.get("host") !== allowedPublicHost &&
      !loopback(req.hostname)
    ) {
      res.status(403).json({ error: "Unrecognized management hostname." });
      return;
    }
    next();
  });
  const accounts = options.accounts;
  if (!options.bootstrap && accounts) {
    const oauthCookie = (res: Response, value: string, age = 600) =>
      res.set(
        "Set-Cookie",
        `bridge_oauth=${value}; Path=/auth/github; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`,
      );
    const invalidLink = (res: Response) =>
      res
        .status(400)
        .type("html")
        .send(linkPage({ state: "error" }));
    // GET/HEAD requests may be made by Discord previews and link scanners.
    // Only a browser-bound, signed form submission consumes the single-use ticket.
    app.get("/auth/github/start", (req, res) => {
      try {
        const ticket = String(req.query.ticket ?? "");
        accounts.validateStart(ticket);
        const nonce = randomBytes(32).toString("base64url");
        const formToken = `${nonce}.${store.sign(`oauth-start:${ticket}:${nonce}`)}`;
        res.cookie("bridge_link_start", formToken, {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/auth/github",
          maxAge: 600_000,
        });
        res.type("html").send(linkPage({ state: "start", ticket, formToken }));
      } catch {
        invalidLink(res);
      }
    });
    app.post(
      "/auth/github/start",
      express.urlencoded({ extended: false, limit: "2kb" }),
      (req, res) => {
        const ticket = String(req.body?.ticket ?? "");
        const formToken = String(req.body?.formToken ?? "");
        const cookieToken =
          (req.get("cookie") ?? "")
            .split(";")
            .map((v) => v.trim())
            .find((v) => v.startsWith("bridge_link_start="))
            ?.slice("bridge_link_start=".length) ?? "";
        const match = formToken.match(/^([a-zA-Z0-9_-]{43})\.([a-f0-9]{64})$/);
        if (
          !match ||
          cookieToken !== formToken ||
          !timingSafeEqual(
            Buffer.from(match[2]),
            Buffer.from(store.sign(`oauth-start:${ticket}:${match[1]}`)),
          )
        ) {
          res
            .status(403)
            .type("html")
            .send(
              linkPage({
                state: "error",
                message:
                  "The confirmation page expired. Reopen your Discord link and try again.",
              }),
            );
          return;
        }
        // no-referrer and privacy browsers may legitimately send Origin: null.
        // The signed form token and HttpOnly cookie remain required in every case.
        const originHeader = req.get("origin");
        if (originHeader && originHeader !== "null") {
          try {
            const origin = new URL(originHeader);
            if (
              origin.host !== req.get("host") ||
              !["http:", "https:"].includes(origin.protocol)
            )
              throw new Error("origin");
          } catch {
            res
              .status(403)
              .type("html")
              .send(
                linkPage({
                  state: "error",
                  message:
                    "This request could not be verified. Reopen your Discord link and try again.",
                }),
              );
            return;
          }
        }
        try {
          const result = accounts.start(ticket);
          res.clearCookie("bridge_link_start", {
            httpOnly: true,
            secure: true,
            sameSite: "lax",
            path: "/auth/github",
          });
          oauthCookie(res, result.browser);
          res.redirect(303, result.url);
        } catch {
          invalidLink(res);
        }
      },
    );
    app.get("/auth/github/callback", async (req, res) => {
      const browser =
        (req.get("cookie") ?? "")
          .split(";")
          .map((v) => v.trim())
          .find((v) => v.startsWith("bridge_oauth="))
          ?.slice(13) ?? "";
      oauthCookie(res, "", 0);
      try {
        const identity = await accounts.callback(
          String(req.query.state ?? ""),
          browser,
          String(req.query.code ?? ""),
        );
        if (
          options.webAuth?.user(browserSession(req))?.discord ===
          identity.discord
        ) {
          res.redirect(303, "/dashboard");
          return;
        }
        res
          .type("html")
          .send(linkPage({ state: "success", login: identity.login }));
      } catch {
        res
          .status(400)
          .type("html")
          .send(
            linkPage({
              state: "error",
              message:
                "GitHub authorization could not be verified. Return to Discord and run /github link again.",
            }),
          );
      }
    });
  }
  if (!options.bootstrap) {
    app.get("/health", (_req, res) =>
      res.json({ status: "ok", adminConfigured: store.hasAdmin() }),
    );
    app.post(
      "/github-webhook",
      express.raw({ type: "application/json", limit: "5mb" }),
      (req, res) => {
        const secret = store.secret("webhook");
        if (
          !secret ||
          !Buffer.isBuffer(req.body) ||
          !verifySignature(
            secret,
            req.body.toString("utf8"),
            req.get("x-hub-signature-256") ?? "",
          )
        ) {
          res.status(401).json({ error: "Invalid webhook signature" });
          return;
        }
        let payload;
        try {
          payload = JSON.parse(req.body.toString("utf8"));
        } catch {
          res.status(400).json({ error: "Invalid JSON" });
          return;
        }
        const id = req.get("x-github-delivery"),
          event = req.get("x-github-event");
        if (!id) {
          res.status(400).json({ error: "Missing delivery ID" });
          return;
        }
        if (event === "ping") {
          res.json({ ok: true });
          return;
        }
        if (
          event === "github_app_authorization" &&
          payload.action === "revoked"
        ) {
          if (!Number.isSafeInteger(payload.sender?.id)) {
            res.status(400).json({ error: "Invalid GitHub identity" });
            return;
          }
          accounts?.revokeGithub(String(payload.sender.id));
          res.json({ ok: true });
          return;
        }
        if (
          ["installation", "installation_repositories"].includes(event ?? "")
        ) {
          options.installations?.clear();
          void runtime.reload();
          res.status(202).json({ ok: true });
          return;
        }
        const name = payload?.repository?.full_name;
        if (typeof name !== "string") {
          res.status(400).json({ error: "Missing repository" });
          return;
        }
        const mapping = store
          .mappings()
          .find(
            (m) => `${m.owner}/${m.repo}`.toLowerCase() === name.toLowerCase(),
          );
        if (!mapping) {
          res.status(403).json({ error: "Repository is not mapped" });
          return;
        }
        if (
          !mapping.enabled ||
          !["issues", "issue_comment"].includes(event ?? "") ||
          payload.issue?.pull_request
        ) {
          res.status(202).json({ ignored: true });
          return;
        }
        if (
          !Number.isSafeInteger(payload.issue?.number) ||
          payload.issue.number < 1
        ) {
          res.status(400).json({ error: "Invalid issue number" });
          return;
        }
        const worker = runtime.worker(mapping.id);
        if (!worker) {
          res.status(503).json({ error: "Mapping is initializing" });
          return;
        }
        try {
          worker.store.receive(id, {
            type: "github",
            issue: payload.issue.number,
          });
          res.status(202).json({ queued: true });
        } catch {
          res.status(503).json({ error: "Unable to persist webhook" });
        }
      },
    );
  }
  if (
    !options.bootstrap &&
    options.webAuth &&
    options.userAccess &&
    accounts &&
    options.installations
  )
    app.use(
      createUserRouter(
        store,
        runtime as UserControl,
        options.webAuth,
        accounts,
        options.userAccess,
        options.installations!,
      ),
    );
  app.get("/", (_req, res) =>
    res.type("html").send(options.bootstrap ? html : userHtml),
  );
  app.get("/dashboard", (_req, res) => res.type("html").send(userHtml));
  app.get("/admin", (_req, res) => res.type("html").send(html));
  app.get("/link.css", (_req, res) => res.type("css").send(linkCss));
  app.get("/style.css", (_req, res) => res.type("css").send(css));
  app.get("/app.js", (_req, res) =>
    res.type("application/javascript").send(js),
  );
  app.use("/api", express.json({ limit: "32kb" }));
  const token = (req: Request) =>
    (req.get("cookie") ?? "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("bridge_session="))
      ?.slice("bridge_session=".length) ?? "";
  const authorized = (req: Request) => store.validSession(token(req));
  const cookie = (
    req: Request,
    res: Response,
    value: string,
    maxAge = 12 * 3600,
  ) =>
    res.set(
      "Set-Cookie",
      `bridge_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${!options.bootstrap && !loopback(req.hostname) ? "; Secure" : ""}`,
    );
  app.use("/api", (req, res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      let origin;
      try {
        origin = new URL(req.get("origin") ?? "");
      } catch {
        res.status(403).json({ error: "Missing request origin" });
        return;
      }
      if (
        origin.host !== req.get("host") ||
        !["http:", "https:"].includes(origin.protocol)
      ) {
        res.status(403).json({ error: "Cross-origin request rejected" });
        return;
      }
      if (!req.is("application/json")) {
        res.status(415).json({ error: "Use application/json" });
        return;
      }
    }
    next();
  });
  const action =
    (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
    (req: Request, res: Response) => {
      Promise.resolve()
        .then(() => fn(req, res))
        .catch((error) => {
          if (error instanceof PublicError)
            res.status(error.status).json({ error: error.message });
          else
            res.status(500).json({
              error: "Operation failed. Check configuration and try again.",
            });
        });
    };
  const attempts = new Map<string, { count: number; until: number }>();
  app.get("/api/session", (req, res) =>
    res.json({
      authenticated: authorized(req),
      setupRequired: !store.hasAdmin(),
      bootstrap: options.bootstrap,
    }),
  );
  app.post(
    "/api/setup",
    action((req, res) => {
      if (!options.bootstrap)
        throw new PublicError(
          "Create the first administrator through the private setup port.",
          403,
        );
      if (store.hasAdmin())
        throw new PublicError("An administrator already exists.", 409);
      const password = field(req.body, "password", false, 256, false);
      if (password.length < 12)
        throw new PublicError("Use a password of at least 12 characters.");
      store.createAdmin(password);
      cookie(req, res, store.session());
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/login",
    action((req, res) => {
      const socket = req.socket.remoteAddress ?? "unknown";
      const ip = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(socket)
        ? (req.get("cf-connecting-ip") ?? socket)
        : socket;
      const previous = attempts.get(ip);
      if (previous && previous.until > Date.now() && previous.count >= 5)
        throw new PublicError(
          "Too many attempts. Try again in 15 minutes.",
          429,
        );
      const password = field(req.body, "password", false, 256, false);
      if (!store.authenticate(password)) {
        const current =
          previous && previous.until > Date.now()
            ? previous
            : { count: 0, until: Date.now() + 15 * 60_000 };
        current.count++;
        attempts.set(ip, current);
        if (attempts.size > 10_000)
          attempts.delete(attempts.keys().next().value!);
        throw new PublicError("Invalid administrator password.", 401);
      }
      attempts.delete(ip);
      cookie(req, res, store.session());
      res.json({ ok: true });
    }),
  );
  app.use("/api", (req, res, next) => {
    if (!authorized(req)) {
      res.status(401).json({ error: "Sign in to continue" });
      return;
    }
    next();
  });
  app.post("/api/logout", (req, res) => {
    store.logout(token(req));
    cookie(req, res, "", 0);
    res.json({ ok: true });
  });
  app.get("/api/state", (_req, res) =>
    res.json({
      ...runtime.status(),
      githubInstallation: options.installations?.config(),
      discordOAuth: options.webAuth?.config(),
      activity: store.activity(),
      githubApp: accounts
        ? { ...accounts.app(), callbackUrl: accounts.callbackUrl }
        : undefined,
      linkedAccounts:
        accounts
          ?.links()
          .map(({ discord, github, login, status, linkedAt }) => ({
            discord,
            github,
            login,
            status,
            linkedAt,
          })) ?? [],
      webhookConfigured: Boolean(store.secret("webhook")),
      webhookUrl: options.publicUrl
        ? `${new URL(options.publicUrl).origin}/github-webhook`
        : undefined,
    }),
  );
  app.post(
    "/api/discord-oauth",
    action((req, res) => {
      if (!options.webAuth)
        throw new PublicError("Discord sign-in is unavailable.", 503);
      try {
        options.webAuth.configure(
          field(req.body, "clientId", false, 25),
          field(req.body, "clientSecret", true, 4096) || undefined,
        );
      } catch (error) {
        throw new PublicError((error as Error).message);
      }
      store.audit("admin", "updated Discord sign-in");
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/github-app",
    action((req, res) => {
      if (!accounts)
        throw new PublicError("Account linking is unavailable.", 503);
      try {
        accounts.saveApp(
          field(req.body, "clientId"),
          field(req.body, "slug"),
          field(req.body, "clientSecret", true, 4096) || undefined,
        );
      } catch (error) {
        throw new PublicError((error as Error).message);
      }
      void runtime.reload();
      res.json({ ok: true });
    }),
  );
  app.delete(
    "/api/github-links/:discord",
    action((req, res) => {
      accounts?.unlink(String(req.params.discord));
      res.json({ ok: true });
    }),
  );
  app.get(
    "/api/channels",
    action(async (_req, res) =>
      res.json({ channels: await runtime.channels() }),
    ),
  );
  app.post(
    "/api/discord",
    action(async (req, res) => {
      const discord = field(req.body, "token", true, 4096),
        secret = field(req.body, "webhookSecret", true, 256);
      if (!discord && !secret)
        throw new PublicError("Enter a bot token or webhook secret to update.");
      if (secret && secret.length < 16)
        throw new PublicError(
          "Use a webhook secret of at least 16 characters.",
        );
      if (discord) {
        try {
          await providers.validateDiscord(discord);
        } catch {
          throw new PublicError(
            "Discord rejected the token. Use a valid bot token.",
          );
        }
        store.saveSecret("discord", discord);
      }
      if (secret) store.saveSecret("webhook", secret);
      store.audit("admin", "updated Discord connection");
      if (discord) void runtime.reload();
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/github-installation",
    action(async (req, res) => {
      if (!options.installations)
        throw new PublicError("Installation access is unavailable.", 503);
      try {
        await options.installations.configure(
          field(req.body, "appId", false, 20),
          field(req.body, "privateKey", true, 16384, false) || undefined,
        );
      } catch (error) {
        throw new PublicError((error as Error).message);
      }
      void runtime.reload();
      res.json({ ok: true });
    }),
  );
  app.get(
    "/api/installations",
    action(async (_req, res) => {
      if (!options.installations)
        throw new PublicError("Configure the GitHub App first.", 503);
      try {
        res.json({
          installations: await options.installations.installations(),
        });
      } catch (error) {
        throw new PublicError((error as Error).message);
      }
    }),
  );
  app.get(
    "/api/repositories",
    action(async (req, res) => {
      if (!options.installations)
        throw new PublicError("Configure the GitHub App first.", 503);
      const installation = Number(req.query.installation);
      try {
        res.json({
          repositories: await options.installations.repositories(installation),
        });
      } catch (error) {
        throw new PublicError((error as Error).message);
      }
    }),
  );
  app.post(
    "/api/mappings",
    action(async (req, res) => {
      const installation = Number(req.body.installation),
        repository = field(req.body, "repository", false, 201),
        channel = field(req.body, "channel", false, 25);
      if (!options.installations)
        throw new PublicError("Configure the GitHub App first.", 503);
      const [owner, repo, ...rest] = repository.split("/");
      if (
        rest.length ||
        !owner ||
        !repo ||
        !/^[a-zA-Z0-9-]+$/.test(owner) ||
        !/^[-.\w]+$/.test(repo)
      )
        throw new PublicError("Select a valid owner/repository.");
      if (!/^\d{5,25}$/.test(channel))
        throw new PublicError("Invalid Discord forum.");
      const channels = await runtime.channels();
      if (!channels.some((c) => c.id === channel))
        throw new PublicError(
          "Select a forum available to the connected Discord bot.",
        );
      let validated;
      try {
        validated = await options.installations.repositories(installation);
      } catch {
        throw new PublicError("Unable to check repository access.");
      }
      if (
        !validated.some(
          (r) => r.fullName.toLowerCase() === repository.toLowerCase(),
        )
      )
        throw new PublicError(
          "Repository is not accessible through this app installation.",
        );
      if (
        store
          .mappings()
          .some(
            (m) =>
              m.channel === channel ||
              `${m.owner}/${m.repo}`.toLowerCase() === repository.toLowerCase(),
          )
      )
        throw new PublicError(
          "This repository or forum is already mapped. Each pair has one saved mapping, including paused mappings.",
        );
      if (
        req.body.backfill !== undefined &&
        typeof req.body.backfill !== "boolean"
      )
        throw new PublicError("Invalid import option.");
      const mapping = {
        id: randomUUID(),
        owner,
        repo,
        channel,
        installation,
        repositoryId: validated.find(
          (r) => r.fullName.toLowerCase() === repository.toLowerCase(),
        )!.id,
        guildId: channels.find((c) => c.id === channel)?.guildId,
        backfill: req.body.backfill === true,
        enabled: true,
        roles: roles(req.body.roles),
      };
      store.saveMapping(mapping);
      store.audit("admin", "created mapping", mapping);
      void runtime.reload();
      res.status(201).json({ mapping });
    }),
  );
  app.post(
    "/api/mappings/:id",
    action((req, res) => {
      const mapping = store.mapping(String(req.params.id));
      if (!mapping) throw new PublicError("Mapping not found.", 404);
      if (typeof req.body.enabled !== "boolean")
        throw new PublicError("Invalid mapping state.");
      store.saveMapping({ ...mapping, enabled: req.body.enabled });
      store.audit(
        "admin",
        req.body.enabled ? "resumed mapping" : "paused mapping",
        mapping,
      );
      void runtime.reload();
      res.json({ ok: true });
    }),
  );
  for (const task of ["scan", "retry"] as const)
    app.post(
      `/api/mappings/:id/${task}`,
      action((req, res) => {
        const mapping = store.mapping(String(req.params.id));
        const worker = mapping && runtime.worker(mapping.id);
        if (!mapping || !worker)
          throw new PublicError("Mapping is not initialized.", 404);
        if (task === "scan")
          worker.store.enqueue({ type: "scan" }, randomUUID());
        else {
          worker.store.db.exec(
            "UPDATE jobs SET attempts=0,failed=0,next_at=0,error=NULL WHERE failed=1",
          );
          void runtime.reload();
        }
        res.json({ ok: true });
      }),
    );
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  app.use((error: unknown, _req: Request, res: Response, _next: unknown) => {
    const status = (error as { status?: number }).status;
    res.status(status === 413 ? 413 : 400).json({
      error: status === 413 ? "Request is too large" : "Invalid request body",
    });
  });
  return app;
}
