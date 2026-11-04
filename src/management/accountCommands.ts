import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Interaction,
  SlashCommandBuilder,
} from "discord.js";
import { GitHubAccounts } from "./accounts";

export const githubCommand = new SlashCommandBuilder()
  .setName("github")
  .setDescription("Link your GitHub identity for issue sync");
for (const action of ["link", "confirm", "status", "unlink"])
  githubCommand.addSubcommand((sub) =>
    sub.setName(action).setDescription(`${action} your GitHub account`),
  );

export async function accountCommand(
  interaction: Interaction,
  accounts: GitHubAccounts,
  resume: () => void,
): Promise<boolean> {
  if (
    interaction.isButton() &&
    interaction.customId.startsWith("github:confirm:")
  ) {
    await interaction.deferReply({ ephemeral: true });
    try {
      const link = accounts.confirm(
        interaction.user.id,
        interaction.customId.slice("github:confirm:".length),
      );
      resume();
      await interaction.editReply(
        `Linked to GitHub @${link.login}. Held messages will be checked again. GitHub repository permissions still apply.`,
      );
    } catch (error) {
      await interaction.editReply((error as Error).message);
    }
    return true;
  }
  if (!interaction.isChatInputCommand() || interaction.commandName !== "github")
    return false;
  await interaction.deferReply({ ephemeral: true });
  try {
    const discord = interaction.user.id;
    switch (interaction.options.getSubcommand()) {
      case "link":
        await interaction.editReply(
          `Authorize your GitHub account using this private, single-use link (expires in 10 minutes):\n${accounts.begin(discord)}\nThen return here and run /github confirm.`,
        );
        break;
      case "confirm": {
        const pending = accounts.pending(discord);
        if (!pending) {
          await interaction.editReply(
            "No authorization waiting for confirmation. Run /github link first.",
          );
          break;
        }
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`github:confirm:${pending.id}`)
            .setLabel(`Link @${pending.login}`)
            .setStyle(ButtonStyle.Primary),
        );
        await interaction.editReply({
          content: `Confirm that @${pending.login} is your GitHub account. Only confirm an account you own.`,
          components: [row],
        });
        break;
      }
      case "status": {
        const link = accounts.link(discord);
        await interaction.editReply(
          link
            ? `GitHub @${link.login}: ${link.status === "active" ? "linked" : "authorization required — run /github link again"}. Repository access is checked for every write.`
            : "No linked GitHub account. Run /github link to send changes to GitHub.",
        );
        break;
      }
      case "unlink":
        accounts.unlink(discord);
        await interaction.editReply(
          "Your local GitHub link and saved tokens were removed. Future Discord changes will stay in Discord until you link again. You can also revoke this app in GitHub settings.",
        );
    }
  } catch (error) {
    await interaction.editReply((error as Error).message);
  }
  return true;
}
