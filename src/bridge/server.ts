import express from "express";
import { Store } from "./database";
import { verifySignature } from "../webhookSignature";

export function createServer(
  store: Store,
  options: { secret: string; owner: string; repo: string },
  ready: () => boolean,
) {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) => {
    const queue = store.health();
    res
      .status(ready() ? 200 : 503)
      .json({ status: ready() ? "ok" : "starting", ...queue });
  });
  // Keep the old root path as an alias while fixing the documented webhook route.
  app.post(
    ["/github-webhook", "/"],
    express.raw({ type: "application/json", limit: "5mb" }),
    (req, res) => {
      if (
        !Buffer.isBuffer(req.body) ||
        !verifySignature(
          options.secret,
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
      const event = req.get("x-github-event");
      const delivery = req.get("x-github-delivery");
      if (!delivery) {
        res.status(400).json({ error: "Missing delivery ID" });
        return;
      }
      if (event === "ping") {
        res.json({ ok: true });
        return;
      }
      if (
        payload?.repository?.full_name?.toLowerCase() !==
        `${options.owner}/${options.repo}`.toLowerCase()
      ) {
        res
          .status(403)
          .json({ error: "Repository is not configured for this bot" });
        return;
      }
      if (
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
      try {
        // The transaction commits the delivery and job together before acknowledging receipt.
        store.receive(delivery, {
          type: "github",
          issue: payload.issue.number,
        });
        res.status(202).json({ queued: true });
      } catch {
        res.status(503).json({ error: "Unable to persist delivery" });
      }
    },
  );
  return app;
}
