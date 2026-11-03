import { ChatInputCommandInteraction, PermissionFlagsBits } from "discord.js";
import { randomUUID } from "node:crypto";
import { Store } from "./database";
import { Platforms } from "./types";

export async function issueCommand(
  interaction: ChatInputCommandInteraction,
  store: Store,
  api: Pick<Platforms, "getIssue">,
  options: { forum: string; roles: string[] },
) {
  await interaction.deferReply({ ephemeral: true });
  const member = await interaction.guild!.members.fetch(interaction.user.id);
  const forum = await interaction.guild!.channels.fetch(options.forum);
  if (!forum?.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) {
    await interaction.editReply("You do not have access to the issue forum.");
    return;
  }
  const number = interaction.options.getInteger("number");
  const link = number
    ? store.link(number)
    : store.thread(interaction.channelId);
  if (!link || link.disabled) {
    await interaction.editReply(
      "No linked issue. Use this inside a synced thread, or supply its issue number.",
    );
    return;
  }
  const action = interaction.options.getSubcommand();
  if (action === "status") {
    const issue = await api.getIssue(link.issue);
    await interaction.editReply(
      `#${issue.number}: ${issue.state}\n${issue.url}`,
    );
    return;
  }
  if (!["close", "reopen"].includes(action))
    throw new Error("Unknown issue command");
  if (
    !forum.permissionsFor(member)?.has(PermissionFlagsBits.ManageThreads) &&
    !options.roles.some((id) => member.roles.cache.has(id))
  ) {
    await interaction.editReply(
      "Closing/reopening requires Manage Threads in the forum or a configured manager role.",
    );
    return;
  }
  // Acknowledge success only after SQLite commits the authorized command.
  store.enqueue(
    {
      type: "state",
      issue: link.issue,
      state: action === "close" ? "closed" : "open",
    },
    randomUUID(),
  );
  await interaction.editReply(
    `Queued ${action} for #${link.issue}. The thread summary will reflect the result.`,
  );
}
