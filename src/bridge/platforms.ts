import { Octokit } from "@octokit/rest";
import {
  Client,
  ForumChannel,
  Message as DiscordMessage,
  PermissionFlagsBits,
  ThreadChannel,
} from "discord.js";
import { Authorship, Writer, WriteBlocked } from "./authorship";
import { uploadToR2 } from "../r2";
import { chunks, issueSummary, missing, sourceBody } from "./content";
import { Comment, Issue, Link, Message, Platforms, Post } from "./types";

type Options = {
  owner: string;
  repo: string;
  forum: string;
  readToken: () => Promise<string>;
  invalidateReadToken?: () => void;
};

export class LivePlatforms implements Platforms {
  readonly github: Octokit;
  private forum!: ForumChannel;
  private hostedAttachments = new Map<string, string>();
  constructor(
    readonly client: Client,
    readonly options: Options,
    private authorship?: Authorship,
  ) {
    this.github = new Octokit({
      request: { timeout: 30_000 },
    });
    this.github.hook.wrap("request", async (request, requestOptions) => {
      requestOptions.headers.authorization = `Bearer ${await options.readToken()}`;
      try {
        return await request(requestOptions);
      } catch (error) {
        if ((error as { status?: number }).status !== 401) throw error;
        options.invalidateReadToken?.();
        requestOptions.headers.authorization = `Bearer ${await options.readToken()}`;
        return request(requestOptions);
      }
    });
  }
  async initialize() {
    const channel = await this.client.channels.fetch(this.options.forum);
    if (!(channel instanceof ForumChannel))
      throw new Error("DISCORD_CHANNEL_ID must identify a forum channel.");
    this.forum = channel;
    const permissions = channel.permissionsFor(this.client.user!);
    const required = {
      ViewChannel: PermissionFlagsBits.ViewChannel,
      SendMessages: PermissionFlagsBits.SendMessages,
      SendMessagesInThreads: PermissionFlagsBits.SendMessagesInThreads,
      ReadMessageHistory: PermissionFlagsBits.ReadMessageHistory,
      ManageThreads: PermissionFlagsBits.ManageThreads,
    };
    const absent = Object.entries(required)
      .filter(([, bit]) => !permissions?.has(bit))
      .map(([name]) => name);
    if (absent.length)
      throw new Error(`Missing forum permissions: ${absent.join(", ")}`);
    // Fail before accepting work if repository access is misconfigured.
    await this.github.repos.get(this.repo);
  }
  get guildId() {
    return this.forum.guildId;
  }
  private get repo() {
    return { owner: this.options.owner, repo: this.options.repo };
  }
  private issue(data: {
    number: number;
    title: string;
    body?: string | null;
    html_url: string;
    user: { login: string; id?: number } | null;
    state: string;
    labels: (string | { name?: string })[];
    locked: boolean;
    created_at: string;
  }): Issue {
    return {
      number: data.number,
      title: data.title,
      body: data.body ?? "",
      url: data.html_url,
      author: data.user?.login ?? "unknown",
      authorId: data.user?.id === undefined ? undefined : String(data.user.id),
      relay: this.authorship?.verify(
        data.body ?? "",
        String(data.user?.id ?? ""),
        `${this.options.owner}/${this.options.repo}`,
      ),
      own: false,
      state: data.state === "closed" ? "closed" : "open",
      labels: data.labels
        .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
        .filter(Boolean),
      locked: data.locked,
      createdAt: data.created_at,
    };
  }
  async getIssue(number: number) {
    const { data } = await this.github.issues.get({
      ...this.repo,
      issue_number: number,
    });
    if (data.pull_request)
      throw Object.assign(
        new Error("Pull requests are outside this bridge's scope."),
        { status: 404 },
      );
    return this.issue(data);
  }
  async issues(since?: string) {
    const data = await this.github.paginate(this.github.issues.listForRepo, {
      ...this.repo,
      state: "all",
      since,
      per_page: 100,
    });
    return data.filter((i) => !i.pull_request).map((i) => this.issue(i));
  }
  private async userWrite<T>(
    discordId: string | undefined,
    pinned: Writer | undefined,
    operation: (api: Octokit, writer: Writer) => Promise<T>,
  ): Promise<T> {
    if (!discordId || (pinned?.discordId && pinned.discordId !== discordId))
      throw new WriteBlocked(
        discordId,
        "original-author",
        "The original Discord author must link their GitHub account before this change can be sent.",
      );
    const access = await this.authorship?.access(
      discordId,
      pinned?.kind === "user" ? pinned.githubId : undefined,
    );
    if (!access)
      throw new WriteBlocked(
        discordId,
        "link",
        "Link and authorize your GitHub account with /github link, then /github confirm. This change has not been sent to GitHub.",
      );
    const writer: Writer = {
      kind: "user",
      discordId,
      githubId: access.githubId,
      login: access.login,
    };
    const api = new Octokit({
      auth: access.token,
      request: { timeout: 30_000 },
    });
    try {
      return await operation(api, writer);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 401) {
        this.authorship?.invalidate(discordId, access.githubId);
        throw new WriteBlocked(
          discordId,
          "link",
          "Your GitHub authorization expired or was revoked. Run /github link again; this change has not been sent.",
        );
      }
      if (status === 403 || status === 404)
        throw new WriteBlocked(
          discordId,
          "permission",
          "Your GitHub account or GitHub App is not authorized for this repository/action. Check repository access and the app installation. This change has not been sent.",
        );
      throw error;
    }
  }
  private signed(
    body: string,
    kind: "thread" | "message",
    sourceId: string | undefined,
    writer: Writer | undefined,
  ) {
    if (!sourceId || !writer) return body;
    const marker = this.authorship?.sign(
      { kind, sourceId, writer },
      `${this.options.owner}/${this.options.repo}`,
    );
    return marker ? `${body}\n\n${marker}` : body;
  }
  async createIssue(post: Post, marker: string) {
    return this.userWrite(
      post.starter.authorId,
      undefined,
      async (api, writer) => {
        const available = await api.paginate(api.issues.listLabelsForRepo, {
          ...this.repo,
          per_page: 100,
        });
        const labels = post.tags.filter((tag) =>
          available.some((label) => label.name === tag),
        );
        const { data } = await api.issues.create({
          ...this.repo,
          title: post.title,
          labels,
          body: this.signed(
            `${sourceBody(post.starter)}\n\n${marker}`,
            "thread",
            post.id,
            writer,
          ),
        });
        return { ...this.issue(data), writer };
      },
    );
  }
  async editIssue(
    number: number,
    body: string,
    writer?: Writer,
    source?: Message,
  ) {
    await this.userWrite(
      source?.authorId ?? writer?.discordId,
      writer,
      async (api) => {
        await api.issues.update({
          ...this.repo,
          issue_number: number,
          body: this.signed(
            body,
            "thread",
            body.match(/<!-- gd-sync:thread:(\d+) -->/)?.[1],
            writer,
          ),
        });
      },
    );
  }
  async state(number: number, state: "open" | "closed", actor?: string) {
    await this.userWrite(actor, undefined, async (api) => {
      await api.issues.update({ ...this.repo, issue_number: number, state });
    });
  }
  async comments(number: number): Promise<Comment[]> {
    const data = await this.github.paginate(this.github.issues.listComments, {
      ...this.repo,
      issue_number: number,
      per_page: 100,
    });
    return data.map((c) => ({
      id: String(c.id),
      body: c.body ?? "",
      author: c.user?.login ?? "unknown",
      url: c.html_url,
      own: false,
      authorId: c.user?.id === undefined ? undefined : String(c.user.id),
      relay: this.authorship?.verify(
        c.body ?? "",
        String(c.user?.id ?? ""),
        `${this.options.owner}/${this.options.repo}`,
      ),
    }));
  }
  async createComment(number: number, body: string, source?: Message) {
    return this.userWrite(source?.authorId, undefined, async (api, writer) => {
      const response = await api.issues.createComment({
        ...this.repo,
        issue_number: number,
        body: this.signed(body, "message", source?.id, writer),
      });
      return { id: String(response.data.id), writer };
    });
  }
  async editComment(
    id: string,
    body: string,
    writer?: Writer,
    source?: Message,
  ) {
    await this.userWrite(
      source?.authorId ?? writer?.discordId,
      writer,
      async (api) => {
        await api.issues.updateComment({
          ...this.repo,
          comment_id: Number(id),
          body: this.signed(
            body,
            "message",
            body.match(/<!-- gd-sync:message:(\d+) -->/)?.[1],
            writer,
          ),
        });
      },
    );
  }
  async notifyBlocked(source: Message, message: string) {
    if (!source.authorId || !/^\d+$/.test(source.authorId)) return;
    const channel = await this.channel(source.thread);
    if (channel.archived) return;
    await channel.send({
      content: `<@${source.authorId}> ${message}`,
      allowedMentions: { parse: [], users: [source.authorId] },
    });
  }
  private async channel(id: string): Promise<ThreadChannel> {
    const channel = await this.client.channels.fetch(id);
    if (!channel?.isThread() || channel.parentId !== this.options.forum) {
      throw Object.assign(
        new Error("Thread is missing or outside the configured forum."),
        { status: 404 },
      );
    }
    return channel;
  }
  private async message(message: DiscordMessage): Promise<Message> {
    let body = message.content;
    for (const file of message.attachments.values()) {
      let url = file.url;
      if (process.env.R2_BUCKET && this.hostedAttachments.has(file.id)) {
        url = this.hostedAttachments.get(file.id)!;
      } else if (process.env.R2_BUCKET) {
        // Only fetch attachment URLs furnished by Discord, with a bounded size and timeout.
        if (file.size > 20 * 1024 * 1024)
          throw new Error(
            `Attachment ${file.id} exceeds the 20 MiB rehosting limit.`,
          );
        const hostname = new URL(file.url).hostname;
        if (
          hostname !== "cdn.discordapp.com" &&
          hostname !== "media.discordapp.net"
        )
          throw new Error("Unexpected attachment host");
        const response = await fetch(file.url, {
          signal: AbortSignal.timeout(30_000),
          redirect: "error",
        });
        if (!response.ok)
          throw new Error(`Attachment download failed: ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > 20 * 1024 * 1024)
          throw new Error("Attachment exceeds download limit");
        url =
          (await uploadToR2(
            `discord/${message.id}/${file.id}/${file.name}`,
            buffer,
            file.contentType ?? "application/octet-stream",
          )) ?? url;
        this.hostedAttachments.set(file.id, url);
        if (this.hostedAttachments.size > 10_000)
          this.hostedAttachments.delete(
            this.hostedAttachments.keys().next().value!,
          );
      }
      const name = file.name.replace(/[\[\]\r\n]/g, "_");
      body += `\n${file.contentType?.startsWith("image/") ? "!" : ""}[${name}](${url})`;
    }
    return {
      id: message.id,
      thread: message.channelId,
      body,
      url: message.url,
      author: message.author.globalName ?? message.author.username,
      authorId: message.author.id,
      createdAt: message.createdAt?.toISOString(),
      bot: message.author.bot || Boolean(message.webhookId),
      own: message.author.id === this.client.user?.id,
    };
  }
  private async post(channel: ThreadChannel): Promise<Post> {
    const starter = await channel.fetchStarterMessage({ force: true });
    if (!starter)
      throw Object.assign(
        new Error(`Missing starter message in ${channel.id}`),
        { status: 404 },
      );
    return {
      id: channel.id,
      title: channel.name,
      starter: await this.message(starter),
      tags: channel.appliedTags
        .map(
          (id) =>
            this.forum.availableTags.find((tag) => tag.id === id)?.name ?? "",
        )
        .filter(Boolean),
      createdAt: channel.createdAt!.toISOString(),
      archived: channel.archived ?? false,
    };
  }
  async getPost(thread: string) {
    return this.post(await this.channel(thread));
  }
  async posts() {
    // Enumerate archived pages too; an idle thread is still an active GitHub issue.
    const channels = new Map((await this.forum.threads.fetchActive()).threads);
    let before: Date | undefined;
    for (;;) {
      const page = await this.forum.threads.fetchArchived({
        type: "public",
        limit: 100,
        before,
      });
      for (const [id, channel] of page.threads) channels.set(id, channel);
      if (!page.hasMore || !page.threads.size) break;
      before = page.threads.last()!.archiveTimestamp
        ? new Date(page.threads.last()!.archiveTimestamp!)
        : undefined;
      if (!before) break;
    }
    const posts: Post[] = [];
    for (const channel of channels.values()) {
      try {
        posts.push(await this.post(channel));
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    return posts;
  }
  async createPost(issue: Issue) {
    const post = await this.forum.threads.create({
      name: `#${issue.number} ${issue.title}`.slice(0, 100),
      appliedTags: this.tags(issue),
      message: {
        content: chunks(issueSummary(issue), issue.url)[0],
        allowedMentions: { parse: [] },
      },
    });
    return this.post(post);
  }
  private tags(issue: Issue) {
    // Discord allows at most five forum tags per post.
    return this.forum.availableTags
      .filter((t) => issue.labels.includes(t.name))
      .slice(0, 5)
      .map((t) => t.id);
  }
  async updatePost(link: Link, issue: Issue) {
    const channel = await this.channel(link.thread);
    const name = `#${issue.number} ${issue.title}`.slice(0, 100);
    const tags = this.tags(issue);
    const metadataChanged =
      channel.name !== name ||
      channel.locked !== issue.locked ||
      JSON.stringify([...channel.appliedTags].sort()) !==
        JSON.stringify([...tags].sort());
    if (metadataChanged) {
      if (channel.archived) await channel.setArchived(false);
      await channel.edit({ name, appliedTags: tags, locked: issue.locked });
    }
    if (issue.state === "closed" && !channel.archived)
      await channel.setArchived(true);
    // Open issues may be archived from inactivity; only an actual reopen should unarchive.
    if (issue.state === "open" && channel.archived && metadataChanged)
      await channel.setArchived(false);
  }
  async messages(thread: string): Promise<Message[]> {
    const channel = await this.channel(thread);
    const result: Message[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await channel.messages.fetch({
        limit: 100,
        before,
        cache: false,
      });
      for (const message of page.values()) {
        if (message.type === 0 || message.type === 19)
          result.push(await this.message(message));
      }
      if (page.size < 100) break;
      before = page.last()!.id;
    }
    return result.reverse();
  }
  async send(thread: string, body: string, nonce: string) {
    const channel = await this.channel(thread);
    if (channel.archived) await channel.setArchived(false);
    return (
      await channel.send({
        content: body,
        allowedMentions: { parse: [] },
        nonce,
        enforceNonce: true,
      })
    ).id;
  }
  async edit(thread: string, id: string, body: string) {
    const channel = await this.channel(thread);
    if (channel.archived) await channel.setArchived(false);
    await channel.messages.edit(id, {
      content: body,
      allowedMentions: { parse: [] },
    });
  }
}
