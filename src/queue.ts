import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { existsSync } from "node:fs";
import { ManagementStore } from "./management/store";

const directory = path.resolve(process.env.DATA_DIR || "data");
const args = process.argv.slice(2);
let file = path.join(directory, "sync.sqlite"),
  action = args[0] ?? "status",
  job = args[1];
if (existsSync(path.join(directory, "management.sqlite"))) {
  const management = new ManagementStore(directory);
  try {
    const mappings = management.mappings();
    if (action === "list" || args.length === 0) {
      console.table(
        mappings.map((m) => ({
          id: m.id,
          repository: `${m.owner}/${m.repo}`,
          enabled: m.enabled,
        })),
      );
      process.exitCode = 0;
    } else {
      const mapping = mappings.find(
        (m) =>
          m.id === action ||
          `${m.owner}/${m.repo}`.toLowerCase() === action.toLowerCase(),
      );
      if (!mapping)
        throw new Error(
          "Select a mapping ID or owner/repo. Use pnpm queue list first.",
        );
      file =
        mapping.file ?? path.join(directory, "routes", `${mapping.id}.sqlite`);
      action = args[1] ?? "status";
      job = args[2];
    }
  } finally {
    management.close();
  }
  if (args.length === 0 || args[0] === "list") process.exit(0);
}
if (!existsSync(file))
  throw new Error(`No sync database at ${file}; initialize the mapping first.`);
const db = new DatabaseSync(file);
db.exec("PRAGMA busy_timeout=5000");
try {
  if (action === "status")
    console.table(
      db
        .prepare(
          "SELECT id,attempts,failed,error FROM jobs ORDER BY id LIMIT 50",
        )
        .all(),
    );
  else if (action === "retry") {
    if (job === "all")
      db.exec(
        "UPDATE jobs SET attempts=0,failed=0,next_at=0,error=NULL WHERE failed=1",
      );
    else if (job && /^\d+$/.test(job))
      db.prepare(
        "UPDATE jobs SET attempts=0,failed=0,next_at=0,error=NULL WHERE id=?",
      ).run(Number(job));
    else
      throw new Error(
        "Usage: pnpm queue <mapping-id|owner/repo> retry <job-id|all>",
      );
    console.log("Queued for retry.");
  } else
    throw new Error(
      "Usage: pnpm queue <mapping-id|owner/repo> [status|retry <job-id|all>]",
    );
} finally {
  db.close();
}
