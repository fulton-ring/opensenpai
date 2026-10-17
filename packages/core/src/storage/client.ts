import type { Client, Transaction } from "@libsql/client";

export type ResearchConnection = Pick<Transaction, "execute">;
export type ResearchClient = Pick<Client, "execute" | "batch" | "close" | "protocol"> &
  Partial<Pick<Client, "transaction">>;
export type TransactionRunner = <T>(
  operation: (connection: ResearchConnection) => Promise<T>,
) => Promise<T>;
