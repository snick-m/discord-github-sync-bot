import { ManagementStore } from "./store";

/** Seed the first administrator only; later restarts never replace an existing password. */
export function initializeAdmin(store: ManagementStore, env = process.env) {
  const password = env.ADMIN_PASSWORD;
  if (store.hasAdmin() || !password?.trim()) return false;
  if (password.length < 12 || password.length > 256)
    throw new Error(
      "ADMIN_PASSWORD must contain between 12 and 256 characters.",
    );
  store.createAdmin(password);
  return true;
}
