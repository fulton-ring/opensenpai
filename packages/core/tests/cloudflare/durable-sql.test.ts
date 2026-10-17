import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { type RunEstimate, runInputSchema, targetSchema } from "../../src/contracts.js";
import {
  createDurableResearchStore,
  type DurableResearchStorage,
  DurableSqlClient,
  type DurableSqlValue,
} from "../../src/storage/durable-sql.js";

const databases: DatabaseSync[] = [];
function sqliteStorage(): DurableResearchStorage {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  let pending: Promise<unknown> = Promise.resolve();
  return {
    sql: {
      exec(query, ...bindings) {
        const statement = database.prepare(query);
        const columns = statement.columns().map((column) => column.name);
        const rows = statement
          .all(...(bindings as SQLInputValue[]))
          .map(
            (row) =>
              Object.fromEntries(
                Object.entries(row).map(([key, value]) => [
                  key,
                  typeof value === "bigint"
                    ? Number(value)
                    : value instanceof Uint8Array
                      ? value.slice().buffer
                      : value,
                ]),
              ) as Record<string, DurableSqlValue>,
          );
        return Object.assign(rows, { columnNames: columns });
      },
    },
    transaction(operation) {
      const result = pending.then(async () => {
        database.exec("BEGIN IMMEDIATE");
        try {
          const value = await operation();
          database.exec("COMMIT");
          return value;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      });
      pending = result.catch(() => undefined);
      return result;
    },
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

it("materializes cursor rows and reports actual changed rows for conflict-ignore inserts", async () => {
  const client = new DurableSqlClient(sqliteStorage());
  await client.execute("CREATE TABLE example(id INTEGER PRIMARY KEY, value TEXT)");
  const first = await client.execute({ sql: "INSERT INTO example VALUES(?,?)", args: [1, "one"] });
  const duplicate = await client.execute("INSERT OR IGNORE INTO example VALUES(1,'duplicate')");
  const selected = await client.execute("SELECT id,value FROM example");
  await client.execute("DELETE FROM example");
  expect(first.rowsAffected).toBe(1);
  expect(duplicate.rowsAffected).toBe(0);
  expect(selected.columns).toEqual(["id", "value"]);
  expect(selected.rows[0]?.value).toBe("one");
  expect(selected.rows[0]?.[1]).toBe("one");
});

it("rolls back dependent reservations and serializes competing budget claims", async () => {
  const storage = sqliteStorage();
  const store = createDurableResearchStore(storage, "workspace");
  await store.initialize();
  const target = targetSchema.parse({
    id: "t",
    transport: "openai",
    model: "test",
    search: { mode: "off" },
  });
  const input = runInputSchema.parse({
    prompts: [{ id: "p", text: "hello" }],
    targets: ["t"],
    repetitions: 2,
    idempotency_key: "key",
    max_estimated_cost_usd: 0.15,
  });
  const estimate: RunEstimate = {
    total_observations: 2,
    estimated_cost_usd: 0.2,
    retrieval_estimated_cost_usd: 0,
    unpriced_targets: [],
    observations: [0, 1].map((repetition) => ({
      prompt_id: "p",
      target_id: "t",
      repetition,
      estimated_cost_usd: 0.1,
    })),
  };
  const { run } = await store.createRun(input, [target], estimate);
  storage.sql.exec(
    "CREATE TRIGGER reject_claim BEFORE UPDATE ON app_observations BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
  );
  const [first] = await store.listPending();
  if (!first) throw new Error("Missing pending observation");
  await expect(store.claim(first.id, "failed-owner")).rejects.toThrow("injected failure");
  expect((await store.getRun(run.id))?.reserved_cost_usd).toBe(0);
  expect((await store.getObservation(first.id))?.status).toBe("pending");
  storage.sql.exec("DROP TRIGGER reject_claim");
  const claims = await Promise.all(
    (await store.listPending()).map((row) => store.claim(row.id, "owner")),
  );
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect((await store.getRun(run.id))?.reserved_cost_usd).toBe(0.1);
  expect((await store.client.execute("SELECT id FROM app_attempts")).rows).toHaveLength(1);
  expect((await store.createRun(input, [target], estimate)).created).toBe(false);
  await store.close();
  const reopened = createDurableResearchStore(storage, "workspace");
  expect((await reopened.getRun(run.id))?.reserved_cost_usd).toBe(0.1);
});
