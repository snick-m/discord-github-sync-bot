import express, { Request, Response } from "express";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { ManagementStore } from "./store";
import { Runtime } from "./runtime";
import { validateDiscord, validateGithub } from "./providers";
import { verifySignature } from "../webhookSignature";
import { html, css, js } from "./ui";

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
  accounts?: GitHubAccounts;
  publicUrl?: string;
}
export type Control = Pick<
  Runtime,
  "status" | "channels" | "reload" | "worker"
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
  providers = { validateDiscord, validateGithub },
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
        .type("text")
        .send(
          "Link expired or invalid. Return to Discord and run /github link again.",
        );
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
        // validateStart permits only a fixed-length base64url value, safe in this attribute.
        res
          .type("html")
          .send(
            `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Link GitHub account</title><link rel="stylesheet" href="/style.css"><main><section class="panel"><h1>Link your GitHub account.</h1><p>Continue to GitHub to authorize your account, then return to Discord and run <strong>/github confirm</strong>.</p><form method="post" action="/auth/github/start"><input type="hidden" name="ticket" value="${ticket}"><input type="hidden" name="formToken" value="${formToken}"><button type="submit">Continue to GitHub</button></form></section></main></html>`,
          );
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
            .type("text")
            .send(
              "The confirmation page expired. Reopen your Discord link and try again.",
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
            res.status(403).type("text").send("Cross-origin request rejected.");
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
        await accounts.callback(
          String(req.query.state ?? ""),
          browser,
          String(req.query.code ?? ""),
        );
        res
          .type("html")
          .send(
            '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Confirm in Discord</title><link rel="stylesheet" href="/style.css"><main><section class="panel"><h1>Return to Discord.</h1><p>GitHub authorization succeeded. Run <strong>/github confirm</strong> in Discord and confirm the GitHub account shown there to finish linking.</p></section></main></html>',
          );
      } catch {
        res
          .status(400)
          .type("text")
          .send(
            "Authorization could not be verified. Return to Discord and run /github link again.",
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
  app.get("/", (_req, res) => res.type("html").send(html));
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
      credentials: store.credentials(),
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
      if (discord) void runtime.reload();
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/credentials",
    action(async (req, res) => {
      const id = field(req.body, "id", true),
        label = field(req.body, "label"),
        owner = field(req.body, "owner"),
        value = field(req.body, "token", false, 4096);
      if (!/^[a-zA-Z0-9-]+$/.test(owner))
        throw new PublicError("Invalid GitHub resource owner.");
      const previous = id ? store.credential(id) : undefined;
      if (id && !previous) throw new PublicError("Credential not found.", 404);
      if (
        previous &&
        previous.owner.toLowerCase() !== owner.toLowerCase() &&
        store.mappings().some((m) => m.credential === id)
      )
        throw new PublicError(
          "A credential used by mappings must keep the same resource owner.",
        );
      let validated;
      try {
        validated = await providers.validateGithub(value, owner);
      } catch {
        throw new PublicError(
          "GitHub could not validate repository access. Check the token's resource owner, selected repositories, Issues permissions, and organization approval.",
        );
      }
      const credential = store.saveCredential({
        id: id || undefined,
        label,
        owner,
        token: value,
        login: validated.login,
      });
      void runtime.reload();
      res.status(previous ? 200 : 201).json({ credential });
    }),
  );
  app.delete(
    "/api/credentials/:id",
    action((req, res) => {
      const id = String(req.params.id);
      if (store.mappings().some((m) => m.credential === id))
        throw new PublicError(
          "This credential is used by a mapping. Replace its token instead.",
        );
      store.removeCredential(id);
      res.json({ ok: true });
    }),
  );
  app.get(
    "/api/repositories",
    action(async (req, res) => {
      const credential = store.credential(String(req.query.credential ?? ""));
      if (!credential) throw new PublicError("Credential not found.", 404);
      try {
        const result = await providers.validateGithub(
          store.secret(`github:${credential.id}`)!,
          credential.owner,
        );
        res.json({ repositories: result.repositories });
      } catch {
        throw new PublicError(
          "Repository discovery failed. Check token expiration, selected repositories, and organization approval.",
        );
      }
    }),
  );
  app.post(
    "/api/mappings",
    action(async (req, res) => {
      const credentialId = field(req.body, "credential"),
        repository = field(req.body, "repository", false, 201),
        channel = field(req.body, "channel", false, 25);
      const credential = store.credential(credentialId);
      if (!credential) throw new PublicError("Credential not found.", 404);
      const [owner, repo, ...rest] = repository.split("/");
      if (
        rest.length ||
        !owner ||
        !repo ||
        owner.toLowerCase() !== credential.owner.toLowerCase()
      )
        throw new PublicError(
          "Select a repository owned by this credential's resource owner.",
        );
      if (!/^\d{5,25}$/.test(channel))
        throw new PublicError("Invalid Discord forum.");
      const channels = await runtime.channels();
      if (!channels.some((c) => c.id === channel))
        throw new PublicError(
          "Select a forum available to the connected Discord bot.",
        );
      let validated;
      try {
        validated = await providers.validateGithub(
          store.secret(`github:${credential.id}`)!,
          credential.owner,
        );
      } catch {
        throw new PublicError("Unable to check repository access.");
      }
      if (
        !validated.repositories.some(
          (r) => r.fullName.toLowerCase() === repository.toLowerCase(),
        )
      )
        throw new PublicError(
          "Repository is not accessible through this credential.",
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
        credential: credentialId,
        backfill: req.body.backfill === true,
        enabled: true,
        roles: roles(req.body.roles),
      };
      store.saveMapping(mapping);
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
