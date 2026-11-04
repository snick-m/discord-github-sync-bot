import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import { Store } from "./database";
import { issueCommand } from "./commands";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function setup({
  view = true,
  manage = false,
  role = false,
  number = null as number | null,
  action = "close",
} = {}) {
  const store = new Store(":memory:", "test");
  stores.push(store);
  store.saveLink({
    issue: 42,
    thread: "thread",
    origin: "github",
    starter: "starter",
  });
  const permissions = new PermissionsBitField([
    ...(view ? [PermissionFlagsBits.ViewChannel] : []),
    ...(manage ? [PermissionFlagsBits.ManageThreads] : []),
  ]);
  const interaction = {
    user: { id: "user" },
    channelId: number ? "other-channel" : "thread",
    guild: {
      members: {
        fetch: vi.fn(async () => ({
          roles: { cache: new Map(role ? [["manager", {}]] : []) },
        })),
      },
      channels: {
        fetch: vi.fn(async () => ({ permissionsFor: () => permissions })),
      },
    },
    options: { getInteger: () => number, getSubcommand: () => action },
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async (_text: string) => {}),
  };
  const api = { getIssue: vi.fn() };
  const run = () =>
    issueCommand(
      interaction as unknown as ChatInputCommandInteraction,
      store,
      api,
      { forum: "forum", roles: ["manager"] },
    );
  return { store, interaction, api, run };
}
describe("issue command permissions", () => {
  it("denies ordinary members without creating a state mutation", async () => {
    const { run, store, interaction } = setup();
    await run();
    expect(store.health().pending).toBe(0);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("requires Manage Threads"),
    );
  });
  it("allows forum managers and configured roles", async () => {
    for (const options of [{ manage: true }, { role: true }]) {
      const { run, store } = setup(options);
      await run();
      expect(store.next()?.task).toEqual({
        type: "state",
        actor: "user",
        issue: 42,
        state: "closed",
      });
    }
  });
  it("requires forum visibility even for a configured manager role", async () => {
    const { run, store, api } = setup({ view: false, role: true });
    await run();
    expect(store.health().pending).toBe(0);
    expect(api.getIssue).not.toHaveBeenCalled();
  });
  it("can reopen by number from another channel when the thread is archived", async () => {
    const { run, store } = setup({
      manage: true,
      number: 42,
      action: "reopen",
    });
    await run();
    expect(store.next()?.task).toEqual({
      type: "state",
      actor: "user",
      issue: 42,
      state: "open",
    });
  });
});
