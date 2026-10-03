import { it, expect, vi } from "vitest";
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

it("cancels queued admission immediately without releasing the active lease", async () => {
  const lock = new TabWork();
  let finish!: () => void;
  const active = lock.run(
    1,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  const canceledWork = vi.fn(async () => "canceled");
  const canceled = lock.run(1, canceledWork, controller.signal);
  const cancellation = expect(canceled).rejects.toMatchObject({
    name: "AbortError",
  });
  const laterWork = vi.fn(async () => "later");
  const later = lock.run(1, laterWork);
  controller.abort();
  await cancellation;
  await expect(lock.run(2, async () => "other tab")).resolves.toBe("other tab");
  expect(canceledWork).not.toHaveBeenCalled();
  expect(laterWork).not.toHaveBeenCalled();
  finish();
  await active;
  await expect(later).resolves.toBe("later");
  expect(canceledWork).not.toHaveBeenCalled();
  expect(laterWork).toHaveBeenCalledTimes(1);
});

it("does not execute pre-aborted work or disturb an existing tab queue", async () => {
  const lock = new TabWork();
  let finish!: () => void;
  const active = lock.run(
    1,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const reason = new Error("Paused before admission");
  const signal = AbortSignal.abort(reason);
  const skipped = vi.fn(async () => "skipped");
  await expect(lock.run(1, skipped, signal)).rejects.toBe(reason);
  const laterWork = vi.fn(async () => "later");
  const later = lock.run(1, laterWork);
  await lock.run(2, async () => {});
  expect(skipped).not.toHaveBeenCalled();
  expect(laterWork).not.toHaveBeenCalled();
  finish();
  await active;
  await later;
});

it("retains an active lease after cancellation until its cooperative work finishes", async () => {
  const lock = new TabWork();
  const controller = new AbortController();
  let markStarted!: () => void;
  const began = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let release!: () => void;
  let settled = false;
  const active = lock.run(
    1,
    async () => {
      markStarted();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return "finished cooperatively";
    },
    controller.signal,
  );
  void active.then(() => {
    settled = true;
  });
  await began;
  const laterWork = vi.fn(async () => "later");
  const later = lock.run(1, laterWork);
  controller.abort();
  await lock.run(2, async () => {});
  expect(settled).toBe(false);
  expect(laterWork).not.toHaveBeenCalled();
  release();
  await expect(active).resolves.toBe("finished cooperatively");
  await expect(later).resolves.toBe("later");
});

it("skips multiple canceled queue entries even when the preceding operation fails", async () => {
  const lock = new TabWork();
  let reject!: (error: Error) => void;
  const active = lock.run(
    1,
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  const activeFailure = expect(active).rejects.toThrow("read failed");
  const controllers = [new AbortController(), new AbortController()];
  const work = vi.fn(async () => "not called");
  const cancellations = controllers.map((controller) => {
    const result = lock.run(1, work, controller.signal);
    const assertion = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    return assertion;
  });
  const later = lock.run(1, async () => "available");
  await Promise.all(cancellations);
  await lock.run(2, async () => {});
  reject(new Error("read failed"));
  await activeFailure;
  await expect(later).resolves.toBe("available");
  expect(work).not.toHaveBeenCalled();
});

it("honors cancellation before an idle queue admits its first job", async () => {
  const lock = new TabWork();
  const controller = new AbortController();
  const work = vi.fn(async () => "not called");
  const result = lock.run(1, work, controller.signal);
  const assertion = expect(result).rejects.toMatchObject({
    name: "AbortError",
  });
  controller.abort();
  await assertion;
  await expect(lock.run(1, async () => "ready")).resolves.toBe("ready");
  expect(work).not.toHaveBeenCalled();
});
