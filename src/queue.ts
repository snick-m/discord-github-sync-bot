import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { existsSync } from "node:fs";

const file = path.join(process.env.DATA_DIR || "data", "sync.sqlite");
if (!existsSync(file))
  throw new Error(`No database at ${file}; start the bot first.`);
const db = new DatabaseSync(file);
db.exec("PRAGMA busy_timeout=5000");
const action = process.argv[2] ?? "status";
try {
  if (action === "status") {
    console.table(
      db
        .prepare(
          "SELECT id, attempts, failed, error FROM jobs ORDER BY id LIMIT 50",
        )
        .all(),
    );
  } else if (action === "retry") {
    const id = process.argv[3];
    if (id === "all")
      db.exec(
        "UPDATE jobs SET attempts=0,failed=0,next_at=0,error=NULL WHERE failed=1",
      );
    else if (id && /^\d+$/.test(id))
      db.prepare(
        "UPDATE jobs SET attempts=0,failed=0,next_at=0,error=NULL WHERE id=?",
      ).run(Number(id));
    else throw new Error("Usage: pnpm queue retry <job-id|all>");
    console.log("Queued for retry.");
  } else throw new Error("Usage: pnpm queue [status|retry <job-id|all>]");
} finally {
  db.close();
}
