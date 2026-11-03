import { createHash } from "node:crypto";
import { Issue, Message } from "./types";

export const hash = (body: string) =>
  createHash("sha256").update(body).digest("hex");
export const issueMarker = (thread: string) =>
  `<!-- gd-sync:thread:${thread} -->`;
export const messageMarker = (id: string) => `<!-- gd-sync:message:${id} -->`;
export function sourceBody(message: Message) {
  const author = message.author.replace(/[\[\]<>\r\n]/g, "");
  // Remove reserved markers supplied in user content so only our generated marker is authoritative.
  const body = message.body.replace(/<!--\s*gd-sync:[\s\S]*?-->/g, "");
  return `**[${author}](${message.url})** on Discord\n\n${body || "_(No text)_"}`;
}
export function issueSummary(issue: Issue) {
  const body = issue.body.replace(/<!--\s*gd-sync:[\s\S]*?-->/g, "").trim();
  return `**[${issue.state === "closed" ? "Closed" : "Open"} · #${issue.number}](${issue.url})** — ${issue.author}\n\n${body || "_(No description)_"}\n\nLabels: ${issue.labels.join(", ") || "none"}`;
}
/** Split by UTF-16 length (Discord's limit), retaining the source URL in every part. */
export function chunks(body: string, url: string): string[] {
  const parts: string[] = [];
  let remaining = body;
  do {
    let end = Math.min(1700, remaining.length);
    if (end < remaining.length && /[\uD800-\uDBFF]/.test(remaining[end - 1]))
      end--;
    parts.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  } while (remaining.length);
  return parts.map(
    (part, i) => `${part}\n\n↪ ${url} · part ${i + 1}/${parts.length}`,
  );
}
export function missing(error: unknown): boolean {
  const e = error as { status?: number; code?: number };
  return e.status === 404 || e.code === 10003 || e.code === 10008;
}
