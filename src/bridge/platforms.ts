import { Octokit } from "@octokit/rest";
import {
  Client,
  ForumChannel,
  Message as DiscordMessage,
  PermissionFlagsBits,
  ThreadChannel,
} from "discord.js";
import { uploadToR2 } from "../r2";
import { chunks, issueSummary, missing, sourceBody } from "./content";
import { Comment, Issue, Link, Message, Platforms, Post } from "./types";

type Options = { owner: string; repo: string; forum: string; token: string };

export class LivePlatforms implements Platforms {
  readonly github: Octokit;
  private githubLogin = "";
  private forum!: ForumChannel;
  private hostedAttachments = new Map<string, string>();
  constructor(
    readonly client: Client,
    readonly options: Options,
  ) {
    this.github = new Octokit({
      auth: options.token,
      request: { timeout: 30_000 },
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
    this.githubLogin = (await this.github.users.getAuthenticated()).data.login;
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
    user: { login: string } | null;
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
      own: data.user?.login === this.githubLogin,
      state: data.state === "closed" ? "closed" : "open",
      labels: data.labels
        .map((l) => (typeof l === "string" ? l : l.name ?? ""))
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
  async createIssue(post: Post, marker: string) {
    // Only map tags to existing labels: typos must not silently create new labels.
    const available = await this.github.paginate(
      this.github.issues.listLabelsForRepo,
      { ...this.repo, per_page: 100 },
    );
    const labels = post.tags.filter((tag) =>
      available.some((l) => l.name === tag),
    );
    const { data } = await this.github.issues.create({
      ...this.repo,
      title: post.title,
      body: `${sourceBody(post.starter)}\n\n${marker}`,
      labels,
    });
    return this.issue(data);
  }
  async editIssue(number: number, body: string) {
    await this.github.issues.update({
      ...this.repo,
      issue_number: number,
      body,
    });
  }
  async state(number: number, state: "open" | "closed") {
    await this.github.issues.update({
      ...this.repo,
      issue_number: number,
      state,
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
      own: c.user?.login === this.githubLogin,
    }));
  }
  async createComment(number: number, body: string) {
    return String(
      (
        await this.github.issues.createComment({
          ...this.repo,
          issue_number: number,
          body,
        })
      ).data.id,
    );
  }
  async editComment(id: string, body: string) {
    await this.github.issues.updateComment({
      ...this.repo,
      comment_id: Number(id),
      body,
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
