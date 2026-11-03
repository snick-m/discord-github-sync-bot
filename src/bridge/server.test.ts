import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createHmac } from "node:crypto";
import { Store } from "./database";
import { createServer } from "./server";

let store: Store;
const options = { secret: "test-webhook-secret", owner: "owner", repo: "repo" };
beforeEach(() => {
  store = new Store(":memory:", "test");
});
afterEach(() => store.close());
function deliver(
  body: unknown,
  overrides: Record<string, string> = {},
  route = "/github-webhook",
) {
  const raw = JSON.stringify(body);
  const signature =
    "sha256=" + createHmac("sha256", options.secret).update(raw).digest("hex");
  return request(createServer(store, options, () => true))
    .post(route)
    .set({
      "content-type": "application/json",
      "x-hub-signature-256": signature,
      "x-github-event": "issues",
      "x-github-delivery": "delivery-1",
      ...overrides,
    })
    .send(raw);
}
const issue = {
  action: "opened",
  repository: { full_name: "owner/repo" },
  issue: { number: 42 },
};
describe("webhook intake", () => {
  it("commits authenticated deliveries before acknowledging and deduplicates redelivery", async () => {
    expect((await deliver(issue)).status).toBe(202);
    expect((await deliver(issue)).status).toBe(202);
    expect(store.health().pending).toBe(1);
    expect(store.next()?.task).toEqual({ type: "github", issue: 42 });
  });
  it("rejects tampering and repository mismatches without persisting work", async () => {
    expect(
      (await deliver(issue, { "x-hub-signature-256": "sha256=bad" })).status,
    ).toBe(401);
    expect(
      (await deliver({ ...issue, repository: { full_name: "other/repo" } }))
        .status,
    ).toBe(403);
    expect(store.health().pending).toBe(0);
  });
  it("ignores PRs and unrelated events", async () => {
    expect(
      (await deliver({ ...issue, issue: { number: 42, pull_request: {} } }))
        .body.ignored,
    ).toBe(true);
    expect(
      (await deliver(issue, { "x-github-event": "push" })).body.ignored,
    ).toBe(true);
    expect(store.health().pending).toBe(0);
  });
  it("supports ping and the legacy root route", async () => {
    expect((await deliver({}, { "x-github-event": "ping" })).status).toBe(200);
    expect((await deliver(issue, {}, "/")).status).toBe(202);
  });
  it("reports not-ready separately from a live Discord connection", async () => {
    expect(
      (await request(createServer(store, options, () => false)).get("/health"))
        .status,
    ).toBe(503);
  });
  it("rejects missing delivery IDs and malformed issue IDs", async () => {
    expect((await deliver(issue, { "x-github-delivery": "" })).status).toBe(
      400,
    );
    expect((await deliver({ ...issue, issue: { number: "42" } })).status).toBe(
      400,
    );
  });
  it("does not consume delivery IDs if enqueueing fails", () => {
    const enqueue = store.enqueue.bind(store);
    store.enqueue = () => {
      throw new Error("Disk full");
    };
    expect(() => store.receive("delivery", { type: "scan" })).toThrow(
      "Disk full",
    );
    store.enqueue = enqueue;
    store.receive("delivery", { type: "scan" });
    expect(store.health().pending).toBe(1);
  });
});
