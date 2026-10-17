import { createClient } from "@libsql/client";
import { expect, it, vi } from "vitest";
import { writeLock } from "../src/storage/local-write.js";

it("bounds native write wait time without running expired operations", async () => {
  vi.useFakeTimers();
  const client = createClient({ url: "file::memory:" });
  let release: (() => void) | undefined;
  const holding = writeLock(
    client,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  let executed = false;
  const waiting = writeLock(client, async () => {
    executed = true;
  });
  const rejected = expect(waiting).rejects.toMatchObject({ code: "STORAGE_BUSY" });
  await vi.advanceTimersByTimeAsync(5_001);
  await rejected;
  release?.();
  await holding;
  await Promise.resolve();
  expect(executed).toBe(false);
  client.close();
  vi.useRealTimers();
});
