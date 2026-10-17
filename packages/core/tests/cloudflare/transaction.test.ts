import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { ResearchStore } from "../../src/storage/index.js";

it("uses the injected transaction boundary for a complete mutation", async () => {
  const client = createClient({ url: "file::memory:" });
  let transactions = 0;
  const store = new ResearchStore(client, "workspace", {
    transactionRunner: async (operation) => {
      transactions++;
      const tx = await client.transaction("write");
      try {
        const value = await operation(tx);
        await tx.commit();
        return value;
      } finally {
        tx.close();
      }
    },
  });
  try {
    await store.initialize();
    await store.recordToolCall("test");
    expect(transactions).toBe(1);
    expect(await store.listToolCalls()).toMatchObject([{ tool: "test", run_id: null }]);
  } finally {
    await store.close();
  }
});
