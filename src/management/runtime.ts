import {
  Client,
  Events,
  ForumChannel,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Store } from "../bridge/database";
import { Engine } from "../bridge/engine";
import { LivePlatforms } from "../bridge/platforms";
import { issueCommand } from "../bridge/commands";
import { Mapping, ManagementStore } from "./store";
import { Task } from "../bridge/types";

import { WriteBlocked } from "../bridge/authorship";
import { GitHubInstallations } from "./installations";
import { GitHubAccounts } from "./accounts";
import { accountCommand, githubCommand } from "./accountCommands";

interface Worker {
  mapping: Mapping;
  store: Store;
  api?: LivePlatforms;
  engine?: Engine;
  error?: string;
}
export class Runtime {
  private client?: Client;
  private workers = new Map<string, Worker>();
  private timer?: NodeJS.Timeout;
  private scans?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;
  private reloading = false;
  private reloadChain = Promise.resolve();
  discordError?: string;
  constructor(
    readonly management: ManagementStore,
    readonly interval: number,
    readonly accounts?: GitHubAccounts,
    readonly installations?: GitHubInstallations,
  ) {
    this.refreshStores();
  }
  private refreshStores() {
    for (const mapping of this.management.mappings()) {
      const existing = this.workers.get(mapping.id);
      if (existing) {
        existing.mapping = mapping;
        continue;
      }
      const file =
        mapping.file ??
        path.join(this.management.directory, "routes", `${mapping.id}.sqlite`);
      this.workers.set(mapping.id, {
        mapping,
        store: new Store(
          file,
          `${mapping.owner}/${mapping.repo}:${mapping.channel}`.toLowerCase(),
        ),
      });
    }
  }
  worker(id: string) {
    return this.workers.get(id);
  }
  start() {
    this.timer = setInterval(() => {
      void this.drain().catch(() => {
        this.discordError = "Worker storage error. Check service logs.";
      });
    }, 1000);
    this.scans = setInterval(() => {
      for (const w of this.workers.values())
        if (w.mapping.enabled) w.store.enqueue({ type: "scan" });
    }, this.interval);
    this.reload();
  }
  reload() {
    this.refreshStores();
    this.reloadChain = this.reloadChain
      .then(() => this.connect())
      .catch(() => {
        this.discordError =
          "Connection initialization failed. Check credentials and channel permissions.";
      });
    return this.reloadChain;
  }
  private async connect() {
    if (this.stopped) return;
    this.reloading = true;
    try {
      while (this.busy && !this.stopped)
        await new Promise((resolve) => setTimeout(resolve, 100));
      if (this.stopped) return;
      this.client?.destroy();
      this.client = undefined;
      this.discordError = undefined;
      this.refreshStores();
      for (const worker of this.workers.values()) {
        worker.api = undefined;
        worker.engine = undefined;
        worker.error = undefined;
      }
      const token = this.management.secret("discord");
      if (!token) return;
      const client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.Message, Partials.Channel],
      });
      this.client = client;
      const route = (channelId: string, parentId?: string | null) =>
        [...this.workers.values()].find(
          (w) =>
            w.mapping.enabled &&
            (w.mapping.channel === parentId ||
              Boolean(w.store.thread(channelId))),
        );
      const enqueue = (worker: Worker | undefined, task: Task) => {
        if (worker && client === this.client)
          worker.store.enqueue(task, randomUUID());
      };
      client.on(Events.ThreadCreate, (thread) =>
        enqueue(route(thread.id, thread.parentId), {
          type: "discord",
          thread: thread.id,
        }),
      );
      client.on(Events.ThreadDelete, (thread) =>
        enqueue(route(thread.id, thread.parentId), {
          type: "unlink",
          thread: thread.id,
        }),
      );
      const message = (m: {
        channelId: string;
        author?: { bot: boolean } | null;
        channel: { isThread(): boolean; parentId?: string | null };
      }) => {
        if (m.author?.bot) return;
        enqueue(
          route(
            m.channelId,
            m.channel.isThread() ? m.channel.parentId : undefined,
          ),
          { type: "discord", thread: m.channelId },
        );
      };
      client.on(Events.MessageCreate, message);
      client.on(Events.MessageUpdate, (_old, m) => message(m));
      client.on(Events.MessageDelete, message);
      client.on(Events.MessageBulkDelete, (_messages, channel) =>
        enqueue(
          route(channel.id, channel.isThread() ? channel.parentId : undefined),
          { type: "discord", thread: channel.id },
        ),
      );
      client.on(Events.ShardResume, () => {
        for (const w of this.workers.values())
          if (w.mapping.enabled)
            w.store.enqueue({ type: "scan" }, randomUUID());
      });
      client.on(Events.Error, () => {
        this.discordError = "Discord connection error; reconnecting.";
      });
      client.on(Events.InteractionCreate, async (interaction) => {
        try {
          if (
            this.accounts &&
            (await accountCommand(interaction, this.accounts, () =>
              this.resumeHeld(),
            ))
          )
            return;
        } catch {
          // An expired interaction must not stop the gateway or the worker.
          return;
        }
        if (
          !interaction.isChatInputCommand() ||
          interaction.commandName !== "issue"
        )
          return;
        try {
          const repository = interaction.options
            .getString("repository")
            ?.toLowerCase();
          const candidates = [...this.workers.values()].filter(
            (w) =>
              w.mapping.enabled &&
              w.api?.guildId === interaction.guildId &&
              (!repository ||
                `${w.mapping.owner}/${w.mapping.repo}`.toLowerCase() ===
                  repository),
          );
          const worker =
            candidates.find((w) => w.store.thread(interaction.channelId)) ??
            (candidates.length === 1 ? candidates[0] : undefined);
          if (!worker?.api) {
            await interaction.reply({
              content:
                "Use this in a synced thread, or specify repository:owner/repo and number when several repositories are mapped.",
              ephemeral: true,
            });
            return;
          }
          await issueCommand(interaction, worker.store, worker.api, {
            forum: worker.mapping.channel,
            roles: worker.mapping.roles,
            authorize: async (id) => Boolean(await this.accounts?.access(id)),
          });
        } catch {
          const text =
            "Command failed. Check the mapping status in Issue Bridge.";
          if (interaction.deferred || interaction.replied)
            await interaction.editReply(text).catch(() => {});
          else
            await interaction
              .reply({ content: text, ephemeral: true })
              .catch(() => {});
        }
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Discord connection timeout")),
            25_000,
          );
          client.once(Events.ClientReady, () => {
            clearTimeout(timeout);
            resolve();
          });
          void client.login(token).catch((error) => {
            clearTimeout(timeout);
            reject(error);
          });
        });
      } catch {
        client.destroy();
        this.discordError =
          "Discord could not connect. Check the bot token and enable Message Content Intent.";
        return;
      }
      if (this.stopped) {
        client.destroy();
        return;
      }
      const guilds = new Set<string>();
      for (const worker of this.workers.values()) {
        if (!worker.mapping.enabled) continue;
        const mapping = worker.mapping;
        if (!this.installations?.config().configured) {
          worker.error =
            "Configure the GitHub App ID and private key in the dashboard.";
          continue;
        }
        const api = new LivePlatforms(
          client,
          {
            owner: mapping.owner,
            repo: mapping.repo,
            forum: mapping.channel,
            repositoryId: mapping.repositoryId,
            readToken: () =>
              this.installations!.repositoryToken(
                mapping.owner,
                mapping.repo,
                mapping.repositoryId,
                mapping.installation,
              ),
            invalidateReadToken: () =>
              this.installations!.invalidate(mapping.owner, mapping.repo),
          },
          this.accounts,
        );
        try {
          await api.initialize();
          worker.api = api;
          worker.engine = new Engine(worker.store, api, mapping.backfill);
          guilds.add(api.guildId);
          worker.store.enqueue({ type: "scan" }, randomUUID());
        } catch (error) {
          const err = error as { message?: string; status?: number };
          worker.error = err.message?.startsWith("Missing forum permissions:")
            ? err.message
            : `Unable to initialize. Check repository access, app installation, and forum permissions.${err.status ? ` HTTP ${err.status}.` : ""}`;
        }
      }
      const command = new SlashCommandBuilder()
        .setName("issue")
        .setDescription("Manage a synced GitHub issue");
      for (const action of ["status", "close", "reopen"])
        command.addSubcommand((sub) =>
          sub
            .setName(action)
            .setDescription(`${action} a linked issue`)
            .addIntegerOption((option) =>
              option
                .setName("number")
                .setDescription("Issue number; optional inside its thread")
                .setMinValue(1),
            )
            .addStringOption((option) =>
              option
                .setName("repository")
                .setDescription(
                  "owner/repo; required outside a thread when several repositories are mapped",
                ),
            ),
        );
      for (const guild of client.guilds.cache.keys()) {
        await client.application!.commands.create(
          githubCommand.toJSON(),
          guild,
        );
        if (guilds.has(guild))
          await client.application!.commands.create(command.toJSON(), guild);
      }
    } finally {
      this.reloading = false;
    }
  }
  resumeHeld() {
    for (const worker of this.workers.values())
      if (worker.mapping.enabled) {
        worker.store.enqueue({ type: "scan" }, randomUUID());
        worker.store.db.exec(
          "UPDATE jobs SET attempts=0,failed=0,next_at=0 WHERE json_extract(payload, '$.type') = 'state'",
        );
      }
  }
  status() {
    return {
      discord: {
        configured: Boolean(this.management.secret("discord")),
        connected: this.client?.isReady() ?? false,
        name: this.client?.user?.username ?? "Discord bot",
        id: this.client?.user?.id,
        error: this.discordError,
      },
      mappings: this.management.mappings().map((mapping) => {
        const worker = this.workers.get(mapping.id);
        const channel = this.client?.channels.cache.get(mapping.channel);
        return {
          ...mapping,
          file: undefined,
          channelName:
            channel && "name" in channel ? channel.name : mapping.channel,
          ready: Boolean(worker?.engine) && !this.reloading,
          error: worker?.error,
          ...(worker?.store.health() ?? {
            blocked: 0,
            pending: 0,
            failed: 0,
            maxAttempts: 0,
          }),
        };
      }),
    };
  }
  private async userGuild(discord: string, guildId: string) {
    const client = this.client;
    if (!client?.isReady())
      throw new Error("The Discord bot is not connected.");
    const guild = client.guilds.cache.get(guildId);
    if (!guild) throw new Error("The bot is not in this server.");
    const member = await guild.members.fetch({ user: discord, force: true });
    await Promise.all([guild.fetch(), guild.roles.fetch()]);
    if (!member.permissions.has(PermissionFlagsBits.ManageGuild))
      throw new Error("Manage Server permission is required.");
    return { guild, member, client };
  }
  async userGuilds(discord: string) {
    const result: { id: string; name: string }[] = [];
    if (!this.client?.isReady()) return result;
    for (const guild of this.client.guilds.cache.values()) {
      try {
        await this.userGuild(discord, guild.id);
        result.push({ id: guild.id, name: guild.name });
      } catch {
        /* Other servers are outside this user's scope. */
      }
    }
    return result;
  }
  async authorizeForum(discord: string, channelId: string) {
    if (!/^\d{5,25}$/.test(channelId)) throw new Error("Select a valid forum.");
    const channel = await this.client?.channels.fetch(channelId, {
      force: true,
    });
    if (!(channel instanceof ForumChannel))
      throw new Error("Select a forum in a server with this bot.");
    const { guild, member, client } = await this.userGuild(
      discord,
      channel.guildId,
    );
    if (!channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel))
      throw new Error("You cannot view this forum.");
    const needed = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.SendMessagesInThreads,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.ManageThreads,
    ];
    if (!channel.permissionsFor(client.user!)?.has(needed))
      throw new Error(
        "The bot needs View Channel, Send Messages, Send Messages in Threads, Read Message History, and Manage Threads in this forum.",
      );
    return {
      id: channel.id,
      name: channel.name,
      guildId: guild.id,
      guild: guild.name,
    };
  }
  async userChannels(discord: string, guildId: string) {
    const { guild } = await this.userGuild(discord, guildId);
    const result: {
      id: string;
      name: string;
      guildId: string;
      guild: string;
    }[] = [];
    for (const channel of (await guild.channels.fetch()).values())
      if (channel instanceof ForumChannel) {
        try {
          result.push(await this.authorizeForum(discord, channel.id));
        } catch {
          /* Unavailable destinations are not offered. */
        }
      }
    return result;
  }
  async channels() {
    const client = this.client;
    if (!client?.isReady()) return [];
    const result: {
      id: string;
      name: string;
      guild: string;
      guildId: string;
    }[] = [];
    for (const guild of client.guilds.cache.values()) {
      const channels = await guild.channels.fetch();
      for (const channel of channels.values())
        if (
          channel instanceof ForumChannel &&
          channel
            .permissionsFor(client.user!)
            ?.has(PermissionFlagsBits.ViewChannel)
        )
          result.push({
            id: channel.id,
            name: channel.name,
            guild: guild.name,
            guildId: guild.id,
          });
    }
    return result.sort((a, b) =>
      `${a.guild}/${a.name}`.localeCompare(`${b.guild}/${b.name}`),
    );
  }
  private async drain() {
    if (this.busy || this.reloading || this.stopped) return;
    this.busy = true;
    try {
      for (const worker of this.workers.values()) {
        if (
          !worker.mapping.enabled ||
          !worker.engine ||
          !this.client?.isReady()
        )
          continue;
        const job = worker.store.next();
        if (!job) continue;
        try {
          await worker.engine.run(job.task);
          worker.store.complete(job.id);
        } catch (error) {
          if (error instanceof WriteBlocked) {
            worker.store.db
              .prepare("UPDATE jobs SET failed=1,error=? WHERE id=?")
              .run(error.message, job.id);
            continue;
          }
          const err = error as {
            status?: number;
            response?: { headers?: Record<string, string> };
          };
          const headers = err.response?.headers;
          const retry = Number(headers?.["retry-after"]) * 1000;
          const reset =
            Number(headers?.["x-ratelimit-reset"]) * 1000 - Date.now();
          const delay =
            retry > 0
              ? retry
              : headers?.["x-ratelimit-remaining"] === "0" && reset > 0
                ? reset + 1000
                : undefined;
          worker.store.fail(
            job.id,
            job.attempts,
            `Sync failed${err.status ? ` (HTTP ${err.status})` : ""}. Check token access and channel permissions.`,
            delay,
          );
          console.error(
            `Mapping ${worker.mapping.id}: ${job.task.type} job ${job.id} failed${err.status ? ` (HTTP ${err.status})` : ""}.`,
          );
        }
      }
    } finally {
      this.busy = false;
    }
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.scans);
    this.client?.destroy();
    while (this.busy || this.reloading)
      await new Promise((resolve) => setTimeout(resolve, 100));
    for (const worker of this.workers.values()) worker.store.close();
  }
}
