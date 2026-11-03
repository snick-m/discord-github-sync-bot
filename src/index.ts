import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
} from "discord.js";
import { randomUUID } from "node:crypto";
import { settings } from "./bridge/settings";
import { Store } from "./bridge/database";
import { Engine } from "./bridge/engine";
import { LivePlatforms } from "./bridge/platforms";
import { createServer } from "./bridge/server";
import { Task } from "./bridge/types";
import { issueCommand } from "./bridge/commands";

async function main() {
  const options = settings();
  const store = new Store(
    options.file,
    `${options.owner}/${options.repo}:${options.forum}`.toLowerCase(),
  );
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel],
  });
  const api = new LivePlatforms(client, options);
  const engine = new Engine(store, api, options.backfill);
  let initialized = false;
  let stopped = false;
  let draining = false;
  const enqueue = (task: Task, unique = false) => {
    try {
      store.enqueue(task, unique ? randomUUID() : undefined);
    } catch (error) {
      console.error(
        "Failed to persist incoming event",
        error instanceof Error ? error.message : "Unknown error",
      );
      void shutdown(1);
    }
  };
  const server = createServer(
    store,
    options,
    () => initialized && client.isReady() && !stopped,
  ).listen(options.port, "0.0.0.0");
  server.on("error", (error) => {
    console.error("Webhook server failed", error.message);
    void shutdown(1);
  });

  client.on(Events.ThreadCreate, (thread) => {
    if (thread.parentId === options.forum)
      enqueue({ type: "discord", thread: thread.id }, true);
  });
  // Archiving and thread locking deliberately do not change GitHub issue state.
  client.on(Events.ThreadDelete, (thread) => {
    if (thread.parentId === options.forum)
      enqueue({ type: "unlink", thread: thread.id }, true);
  });
  const messageEvent = (message: {
    channelId: string;
    author?: { bot: boolean } | null;
    channel: { isThread(): boolean; parentId?: string | null };
  }) => {
    if (message.author?.bot) return;
    if (
      store.thread(message.channelId) ||
      (message.channel.isThread() && message.channel.parentId === options.forum)
    ) {
      enqueue({ type: "discord", thread: message.channelId }, true);
    }
  };
  client.on(Events.MessageCreate, messageEvent);
  client.on(Events.MessageUpdate, (_old, message) => messageEvent(message));
  client.on(Events.MessageDelete, messageEvent);
  client.on(Events.MessageBulkDelete, (_messages, channel) => {
    if (channel.isThread() && channel.parentId === options.forum)
      enqueue({ type: "discord", thread: channel.id }, true);
  });
  client.on(Events.ShardResume, () => enqueue({ type: "scan" }, true));
  client.on(Events.Error, (error) =>
    console.error("Discord connection error", error.message),
  );
  client.on(Events.Warn, (warning) => console.warn("Discord warning", warning));

  client.on(Events.InteractionCreate, async (interaction) => {
    if (
      !interaction.isChatInputCommand() ||
      interaction.commandName !== "issue"
    )
      return;
    try {
      if (!initialized || interaction.guildId !== api.guildId) {
        await interaction.reply({
          content: "The bridge is not ready in this server.",
          ephemeral: true,
        });
        return;
      }
      await issueCommand(interaction, store, api, options);
    } catch (error) {
      console.error(
        "Issue command failed",
        error instanceof Error ? error.message : "Unknown error",
      );
      const response = "The command failed. Check the bot logs and try again.";
      if (interaction.deferred || interaction.replied)
        await interaction.editReply(response).catch(() => {});
      else
        await interaction
          .reply({ content: response, ephemeral: true })
          .catch(() => {});
    }
  });

  const drain = async () => {
    if (!initialized || draining || stopped) return;
    draining = true;
    try {
      for (let count = 0; count < 25 && !stopped; count++) {
        const job = store.next();
        if (!job) break;
        try {
          await engine.run(job.task);
          store.complete(job.id);
        } catch (error) {
          const err = error as {
            status?: number;
            response?: { headers?: Record<string, string> };
          };
          const headers = err.response?.headers;
          const retryAfter = Number(headers?.["retry-after"]);
          const reset =
            Number(headers?.["x-ratelimit-reset"]) * 1000 - Date.now();
          const delay =
            retryAfter > 0
              ? retryAfter * 1000
              : err.status === 403 &&
                  headers?.["x-ratelimit-remaining"] === "0" &&
                  reset > 0
                ? reset + 1000
                : undefined;
          console.error(
            `Job ${job.id} (${job.task.type}) failed, attempt ${job.attempts + 1}:`,
            error instanceof Error ? error.message : "Unknown error",
          );
          store.fail(
            job.id,
            job.attempts,
            error instanceof Error ? error.message : "Unknown error",
            delay,
          );
          break;
        }
      }
    } finally {
      draining = false;
    }
  };
  const worker = setInterval(() => {
    void drain().catch((error) => {
      console.error(
        "Queue failure",
        error instanceof Error ? error.message : "Unknown error",
      );
      void shutdown(1);
    });
  }, 1000);
  const scans = setInterval(() => {
    if (initialized) enqueue({ type: "scan" });
  }, options.interval);
  async function shutdown(code: number) {
    if (stopped) return;
    stopped = true;
    clearInterval(worker);
    clearInterval(scans);
    server.close();
    client.destroy();
    const deadline = Date.now() + 25_000;
    while (draining && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (!draining) store.close();
    process.exit(code);
  }
  process.once("SIGTERM", () => {
    void shutdown(0);
  });
  process.once("SIGINT", () => {
    void shutdown(0);
  });
  process.once("unhandledRejection", (error) => {
    console.error(
      "Unhandled failure",
      error instanceof Error ? error.message : "Unknown error",
    );
    void shutdown(1);
  });
  client.once(Events.ClientReady, async () => {
    try {
      await api.initialize();
      const command = new SlashCommandBuilder()
        .setName("issue")
        .setDescription("Manage a synced GitHub issue");
      for (const action of ["status", "close", "reopen"]) {
        command.addSubcommand((sub) =>
          sub
            .setName(action)
            .setDescription(`${action} a linked issue`)
            .addIntegerOption((option) =>
              option
                .setName("number")
                .setDescription("Issue number; optional inside its thread")
                .setMinValue(1),
            ),
        );
      }
      await client.application!.commands.create(command.toJSON(), api.guildId);
      enqueue({ type: "scan" }, true);
      initialized = true;
      console.log(
        `Ready: ${options.owner}/${options.repo} ↔ forum ${options.forum}. Database: ${options.file}`,
      );
      await drain();
    } catch (error) {
      console.error(
        "Startup failed",
        error instanceof Error ? error.message : "Unknown error",
      );
      await shutdown(1);
    }
  });
  await client.login(options.discordToken);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Startup failed");
  process.exit(1);
});
