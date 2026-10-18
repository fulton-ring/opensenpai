import type { Client, Transaction } from "@libsql/client";

/** Minimal SQL execution boundary used inside a research transaction. */
export type ResearchConnection = Pick<Transaction, "execute">;
/** Client capabilities needed by research storage, with optional native transactions. */
export type ResearchClient = Pick<Client, "execute" | "batch" | "close" | "protocol"> &
  Partial<Pick<Client, "transaction">>;
/** Run a research mutation atomically using the backing database transaction API. */
export type TransactionRunner = <T>(
  operation: (connection: ResearchConnection) => Promise<T>,
) => Promise<T>;
