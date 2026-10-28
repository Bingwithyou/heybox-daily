import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { Store, type Database, type Statement } from "../src/store.ts";
export function fixture(initialTime = Date.parse("2026-10-27T00:01:00+08:00")) {
  const db = new DatabaseSync(":memory:");
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const migrations = new URL("../../../apps/web/migrations/", import.meta.url);
  for (const file of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(new URL(file, migrations), "utf8"));
  }
  class Query implements Statement {
    readonly sql: string;
    values: unknown[] = [];
    constructor(sql: string) {
      this.sql = sql;
    }
    bind(...values: unknown[]) {
      this.values = values;
      return this;
    }
    execute() {
      queries.push({ sql: this.sql, values: this.values });
      const stmt = db.prepare(this.sql);
      return stmt.all(...(this.values as Array<string | number | null>));
    }
    async first<T>() {
      return (this.execute()[0] || null) as T | null;
    }
    async all<T>() {
      return { results: this.execute() as T[] };
    }
    async run() {
      return { results: this.execute(), success: true };
    }
    async raw() {
      return this.execute().map(row => Object.values(row));
    }
  }
  const adapter: Database = {
    prepare: (sql) => new Query(sql),
    batch: async (statements) => {
      db.exec("BEGIN");
      try {
        const results = statements.map((stmt) => ({ results: (stmt as Query).execute(), success: true }));
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  let now = initialTime;
  return {
    db,
    adapter,
    queries,
    store: new Store(adapter, () => now),
    advance: (ms: number) => {
      now += ms;
    },
    close: () => db.close(),
  };
}

