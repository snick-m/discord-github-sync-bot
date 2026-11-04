import { Octokit } from "@octokit/rest";
export const github = (token: string) =>
  new Octokit({ auth: token, request: { timeout: 20_000 } });
export async function validateGithub(token: string, owner: string) {
  const api = github(token);
  const user = (await api.users.getAuthenticated()).data;
  const repositories = await api.paginate(api.repos.listForAuthenticatedUser, {
    per_page: 100,
    sort: "full_name",
  });
  const visible = repositories.filter(
    (r) =>
      r.owner.login.toLowerCase() === owner.toLowerCase() &&
      r.has_issues &&
      !r.archived,
  );
  if (!visible.length)
    throw new Error(
      "No accessible issue-enabled repositories for this owner. Check token resource owner, selected repositories, organization approval, and permissions.",
    );
  return {
    login: user.login,
    repositories: visible.map((r) => ({
      fullName: r.full_name,
      name: r.name,
      private: r.private,
    })),
  };
}
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
