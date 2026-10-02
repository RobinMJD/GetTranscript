import { it, expect } from "vitest";
import { TabWork } from "../src/lib/tab-work";

it("serializes scans and collection navigation on one tab while other tabs continue", async () => {
  const lock = new TabWork();
  const order: string[] = [];
  let finish!: () => void;
  const single = lock.run(1, async () => {
    order.push("single");
    await new Promise<void>((r) => {
      finish = r;
    });
  });
  const collection = lock.run(1, async () => {
    order.push("collection");
  });
  await lock.run(2, async () => {
    order.push("other");
  });
  expect(order).toEqual(["single", "other"]);
  finish();
  await single;
  await collection;
  expect(order).toEqual(["single", "other", "collection"]);
});
it("releases a failed operation without poisoning later collection work", async () => {
  const lock = new TabWork();
  await expect(
    lock.run(1, async () => {
      throw Error("unavailable");
    }),
  ).rejects.toThrow("unavailable");
  await expect(lock.run(1, async () => "ready")).resolves.toBe("ready");
});
