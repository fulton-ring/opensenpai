import type { Client } from "@libsql/client";
import { ResearchError } from "../contracts.js";

let localWrites: Promise<unknown> = Promise.resolve();
export function writeLock<T>(client: Client, operation: () => Promise<T>): Promise<T> {
  if (client.protocol !== "file") return operation();
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  const waiting = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(
        new ResearchError("STORAGE_BUSY", "Native storage write queue exceeded 5 seconds", true),
      );
    }, 5_000);
  });
  const run = () => {
    clearTimeout(timer);
    if (expired)
      throw new ResearchError("STORAGE_BUSY", "Native storage write queue expired", true);
    return operation();
  };
  // ponytail: serialize native writes to avoid libsql's busy-statement bug; remote SQL owns its locks.
  const result = localWrites.then(run, run);
  localWrites = result.then(
    () => undefined,
    () => undefined,
  );
  return Promise.race([result, waiting]);
}
