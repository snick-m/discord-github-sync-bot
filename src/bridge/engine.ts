import { Store } from "./database";
import {
  chunks,
  hash,
  issueMarker,
  issueSummary,
  messageMarker,
  missing,
  sourceBody,
} from "./content";
import { Issue, Link, Message, Platforms, Task } from "./types";

/** One instance and one consumer per database. All remote mutations pass through this engine. */
export class Engine {
  constructor(
    readonly store: Store,
    readonly api: Platforms,
    readonly backfill: boolean,
  ) {}

  async run(task: Task): Promise<void> {
    switch (task.type) {
      case "scan":
        return this.scan();
      case "github":
        return this.github(task.issue);
      case "discord":
        return this.discord(task.thread);
      case "state": {
        const link = this.store.link(task.issue);
        if (!link || link.disabled) return;
        await this.api.state(task.issue, task.state);
        return this.github(task.issue);
      }
      case "unlink": {
        const link = this.store.thread(task.thread);
        if (link) this.store.saveLink({ ...link, disabled: true });
      }
    }
  }

  async scan() {
    const started = this.store.meta("started")!;
    // Capture the start of the scan and overlap cursors so updates during pagination are replayed.
    const checkpoint = new Date(Date.now() - 60_000).toISOString();
    const since =
      this.store.meta("githubScan") ?? (this.backfill ? undefined : started);
    const issues = await this.api.issues(since);
    for (const issue of issues) {
      if (
        this.store.link(issue.number) ||
        (issue.state === "open" &&
          (this.backfill || issue.createdAt >= started))
      ) {
        this.store.enqueue({ type: "github", issue: issue.number });
      }
    }
    for (const post of await this.api.posts()) {
      if (
        this.store.thread(post.id) ||
        post.createdAt >= started ||
        (this.backfill && !post.archived)
      ) {
        this.store.enqueue({ type: "discord", thread: post.id });
      }
    }
    // Fetch every linked issue as well: comments, edits, removals, and state converge after outages.
    for (const link of this.store.links())
      if (!link.disabled) {
        this.store.enqueue({ type: "github", issue: link.issue });
        this.store.enqueue({ type: "discord", thread: link.thread });
      }
    this.store.setMeta("githubScan", checkpoint);
    this.store.prune();
  }

  async github(number: number) {
    let link = this.store.link(number);
    if (link?.disabled) return;
    let issue: Issue;
    try {
      issue = await this.api.getIssue(number);
    } catch (error) {
      if (missing(error)) {
        if (link) this.store.saveLink({ ...link, disabled: true });
        return;
      }
      throw error;
    }
    if (!link) {
      if (issue.state === "closed") return;
      if (!this.backfill && issue.createdAt < this.store.meta("started")!)
        return;
      // Recover a successful Discord→GitHub create whose response/database write was interrupted.
      const source =
        issue.own && issue.body.match(/<!-- gd-sync:thread:(\d+) -->/);
      if (source) {
        const post = await this.api.getPost(source[1]);
        link = {
          issue: number,
          thread: post.id,
          starter: post.starter.id,
          origin: "discord",
        };
      } else {
        // Recover a successful forum create before retrying it. Include archived threads.
        const existing = (await this.api.posts()).find(
          (p) => p.starter.own && p.starter.body.includes(issue.url),
        );
        const post = existing ?? (await this.api.createPost(issue));
        link = {
          issue: number,
          thread: post.id,
          starter: post.starter.id,
          origin: "github",
        };
      }
      this.store.saveLink(link);
    }
    try {
      await this.api.updatePost(link, issue);
      const history = await this.api.messages(link.thread);
      // A bot-owned summary works for human-created starters too: never edit another user's message.
      await this.render(
        link,
        "summary",
        issueSummary(issue),
        issue.url,
        issue.number.toString(),
        history,
      );
      const comments = await this.api.comments(number);
      for (const comment of comments) {
        // Identity plus persisted mappings prevent echoes. A pasted Discord URL is not an echo.
        if (comment.own && /<!-- gd-sync:message:\d+ -->/.test(comment.body))
          continue;
        if (
          this.store
            .mirrors(number)
            .some((m) => m.origin === "discord" && m.ids.includes(comment.id))
        )
          continue;
        await this.render(
          link,
          `github:${comment.id}`,
          `**${comment.author}** on GitHub\n\n${comment.body}`,
          comment.url,
          comment.id,
          history,
        );
      }
      const ids = new Set(comments.map((c) => c.id));
      for (const mirror of this.store.mirrors(number)) {
        if (
          mirror.origin === "github" &&
          mirror.key !== `summary:${number}` &&
          !ids.has(mirror.source)
        ) {
          await this.render(
            link,
            mirror.key,
            "_(This comment was deleted on GitHub.)_",
            `${issue.url}#issuecomment-${mirror.source}`,
            mirror.source,
            history,
          );
        }
      }
      // Posting a comment can unarchive a closed thread, so apply state last as well.
      await this.api.updatePost(link, issue);
    } catch (error) {
      if (missing(error)) {
        // Only an actually missing thread disables the mapping; missing mirror messages are repaired in render().
        try {
          await this.api.getPost(link.thread);
        } catch (check) {
          if (missing(check)) {
            this.store.saveLink({ ...link, disabled: true });
            return;
          }
        }
      }
      throw error;
    }
  }

  private async render(
    link: Link,
    key: string,
    body: string,
    url: string,
    source: string,
    history: Message[],
  ) {
    if (key === "summary") key = `summary:${link.issue}`;
    let mirror = this.store.mirror(key);
    const content = chunks(body, url);
    const digest = hash(JSON.stringify(content));
    if (
      mirror?.hash === digest &&
      mirror.ids.every((id) => history.some((m) => m.id === id))
    )
      return;
    if (!mirror) {
      mirror = {
        key,
        issue: link.issue,
        origin: "github",
        source,
        ids: [],
        hash: "",
      };
      // The first summary part is the starter when the bot created the post.
      if (key === `summary:${link.issue}` && link.origin === "github")
        mirror.ids.push(link.starter);
      this.store.saveMirror(mirror);
    }
    for (let i = 0; i < Math.max(content.length, mirror.ids.length); i++) {
      const text =
        content[i] ??
        `_(Content moved or shortened.)_\n\n↪ ${url} · former part ${i + 1}`;
      let id: string | undefined = mirror.ids[i];
      if (id) {
        try {
          await this.api.edit(link.thread, id, text);
        } catch (error) {
          if (!missing(error)) throw error;
          id = undefined;
        }
      }
      if (!id) {
        // Exact bot-authored content recovers writes even after Discord's short nonce window expires.
        const recovered = history.find((m) => m.own && m.body === text);
        id =
          recovered?.id ??
          (await this.api.send(
            link.thread,
            text,
            hash(`${key}:${i}:${text}`).slice(0, 24),
          ));
        mirror.ids[i] = id;
        this.store.saveMirror(mirror);
      }
    }
    mirror.hash = digest;
    this.store.saveMirror(mirror);
  }

  async discord(thread: string) {
    let link = this.store.thread(thread);
    if (link?.disabled) return;
    let post;
    try {
      post = await this.api.getPost(thread);
    } catch (error) {
      if (missing(error)) {
        if (link) this.store.saveLink({ ...link, disabled: true });
        return;
      }
      throw error;
    }
    if (!link) {
      if (post.starter.bot) return;
      const marker = issueMarker(thread);
      const existing = (await this.api.issues()).find(
        (i) => i.own && i.body.includes(marker),
      );
      const issue = existing ?? (await this.api.createIssue(post, marker));
      link = {
        issue: issue.number,
        thread,
        starter: post.starter.id,
        origin: "discord",
      };
      this.store.saveLink(link);
    }
    if (link.origin === "discord") {
      const body = `${sourceBody(post.starter)}\n\n${issueMarker(thread)}`;
      const key = `body:${thread}`;
      if (this.store.meta(key) !== hash(body)) {
        await this.api.editIssue(link.issue, body);
        this.store.setMeta(key, hash(body));
      }
    }
    const messages = await this.api.messages(thread);
    let comments: Awaited<ReturnType<Platforms["comments"]>> | undefined;
    const sourceIds = new Set(messages.filter((m) => !m.bot).map((m) => m.id));
    for (const message of messages) {
      if (message.bot || message.id === link.starter) continue;
      const key = `discord:${message.id}`;
      const body = `${sourceBody(message)}\n\n${messageMarker(message.id)}`;
      let mirror = this.store.mirror(key);
      if (mirror?.hash === hash(body)) continue;
      if (!mirror) {
        comments ??= await this.api.comments(link.issue);
        const recovered = comments.find(
          (c) => c.own && c.body.includes(messageMarker(message.id)),
        );
        const id =
          recovered?.id ?? (await this.api.createComment(link.issue, body));
        mirror = {
          key,
          issue: link.issue,
          origin: "discord",
          source: message.id,
          ids: [id],
          hash: "",
        };
        this.store.saveMirror(mirror);
      }
      await this.api.editComment(mirror.ids[0], body);
      mirror.hash = hash(body);
      this.store.saveMirror(mirror);
    }
    for (const mirror of this.store.mirrors(link.issue)) {
      if (
        mirror.origin !== "discord" ||
        sourceIds.has(mirror.source) ||
        mirror.hash === "deleted"
      )
        continue;
      try {
        await this.api.editComment(
          mirror.ids[0],
          `_(This message was deleted on Discord.)_\n\n${messageMarker(mirror.source)}`,
        );
      } catch (error) {
        if (!missing(error)) throw error;
      }
      mirror.hash = "deleted";
      this.store.saveMirror(mirror);
    }
    this.store.enqueue({ type: "github", issue: link.issue });
  }
}
