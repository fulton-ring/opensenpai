import type { InArgs, InStatement, InValue, ResultSet, Row, TransactionMode } from "@libsql/client";
import type { ResearchClient } from "./client.js";
import { ResearchStore, type StoreOptions } from "./index.js";

/** SQLite bindings accepted by Cloudflare Durable Object storage. */
export type DurableSqlValue = string | number | null | ArrayBuffer;
/** Structural cursor contract consumed synchronously before yielding execution. */
export interface DurableSqlCursor extends Iterable<Record<string, DurableSqlValue>> {
  columnNames: string[];
}
/** Native SQL and async transaction capabilities required from a Durable Object. */
export interface DurableResearchStorage {
  sql: { exec(query: string, ...bindings: DurableSqlValue[]): DurableSqlCursor };
  transaction<T>(operation: () => Promise<T>): Promise<T>;
}

function binding(value: InValue): DurableSqlValue {
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "bigint") {
    const number = Number(value);
    if (!Number.isSafeInteger(number))
      throw new RangeError("SQLite integer exceeds safe precision");
    return number;
  }
  if (value instanceof Date) return value.valueOf();
  if (value instanceof Uint8Array) return value.slice().buffer as ArrayBuffer;
  return value;
}

function statement(input: InStatement, supplied?: InArgs) {
  const sql = typeof input === "string" ? input : input.sql;
  const args = supplied ?? (typeof input === "string" ? [] : (input.args ?? []));
  if (!Array.isArray(args)) throw new TypeError("Research SQLite requires positional bindings");
  return { sql, args: args.map(binding) };
}

/** Adapt native Durable Object SQL to the research store’s SQL client contract. */
export class DurableSqlClient implements ResearchClient {
  readonly protocol = "cloudflare";
  constructor(private readonly storage: DurableResearchStorage) {}

  async execute(input: InStatement, args?: InArgs): Promise<ResultSet> {
    const query = statement(input, args);
    const cursor = this.storage.sql.exec(query.sql, ...query.args);
    const columns = [...cursor.columnNames];
    // Consume every cursor before the first await; cursors do not preserve snapshots across awaits.
    const rows = Array.from(cursor, (row) =>
      Object.assign(
        columns.map((column) => row[column] ?? null),
        row,
      ),
    ) as Row[];
    // rowsWritten includes index writes. changes() counts the logical rows used by settlement.
    const metadata = Array.from(
      this.storage.sql.exec("SELECT changes() affected, last_insert_rowid() inserted"),
    )[0];
    const result: ResultSet = {
      columns,
      columnTypes: columns.map(() => ""),
      rows,
      rowsAffected: Number(metadata?.affected ?? 0),
      lastInsertRowid:
        metadata?.inserted === undefined ? undefined : BigInt(Number(metadata.inserted)),
      toJSON: () => ({ ...result, lastInsertRowid: result.lastInsertRowid?.toString() }),
    };
    return result;
  }

  async batch(statements: InStatement[], _mode?: TransactionMode): Promise<ResultSet[]> {
    return this.storage.transaction(async () => {
      const results: ResultSet[] = [];
      for (const input of statements) results.push(await this.execute(input));
      return results;
    });
  }

  close(): void {
    // Durable Object storage belongs to the object and outlives container clients.
  }
}

/** Create workspace-scoped research persistence using native Durable Object transactions. */
export function createDurableResearchStore(
  storage: DurableResearchStorage,
  workspaceId: string,
  options: Omit<StoreOptions, "transactionRunner"> = {},
): ResearchStore {
  const client = new DurableSqlClient(storage);
  return new ResearchStore(client, workspaceId, {
    ...options,
    transactionRunner: (operation) => storage.transaction(() => operation(client)),
  });
}
