import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";
import { DB_PATH, ensureDirs } from "@/lib/paths";

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Opened on first use, not on import.
 *
 * `next build` imports every route in parallel workers to collect page data.
 * When this module opened the database at import time, three workers raced to
 * create and migrate a fresh file and one of them lost: SQLITE_BUSY, and the
 * build failed. On a machine where the file already existed it merely logged
 * "migration failed" - the same race, caught - which is why it looked harmless
 * for so long. A build should not be touching a database at all; now it does
 * not, because nothing here runs until a request actually needs it.
 */
let instance: Db | null = null;

function open(): Db {
  ensureDirs();

  const sqlite = new Database(DB_PATH);
  // Wait for a lock before giving up, and set that before anything that could
  // need one - switching the journal mode takes an exclusive lock.
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("journal_mode = WAL");

  const db = drizzle(sqlite, { schema });

  // Overridable because a packaged build does not run from the repo, and the
  // working directory it does run from is the packager's business rather than
  // something to be assumed here.
  const migrationsFolder = process.env.MIGRATIONS_DIR
    ? path.resolve(process.env.MIGRATIONS_DIR)
    : path.join(process.cwd(), "drizzle");

  if (fs.existsSync(migrationsFolder)) {
    try {
      migrate(db, { migrationsFolder });
    } catch (error) {
      console.error("[db] migration failed:", error);
    }
  } else {
    // Loudly. This used to pass in silence, which is the wrong way round: a
    // missing migrations folder means the schema stays at whatever the file
    // happens to hold, and the failures turn up later as missing columns.
    console.error(
      `[db] no migrations at ${migrationsFolder} - the schema will be whatever ` +
        `the database already had. Set MIGRATIONS_DIR if they live elsewhere.`,
    );
  }

  return db;
}

/** The same `db` everything imports; it just does not exist until first use. */
export const db: Db = new Proxy({} as Db, {
  get(_target, property, _receiver) {
    instance ??= open();
    const value = Reflect.get(instance, property, instance);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});
