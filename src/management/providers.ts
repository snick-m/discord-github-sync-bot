export async function validateDiscord(token: string) {
  const response = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new Error(
      `Discord rejected the bot token (HTTP ${response.status}).`,
    );
  const user = (await response.json()) as { bot?: boolean; username?: string };
  if (!user.bot) throw new Error("Provide a Discord bot token.");
  return user.username ?? "Discord bot";
}
