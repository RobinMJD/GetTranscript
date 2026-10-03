/** Serialize all operations that can change a player's controls or navigate its tab. */
export class TabWork {
  private tails = new Map<number, Promise<unknown>>();
  run<T>(
    tabId: number,
    work: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const reason = () =>
      signal?.reason ??
      new DOMException("The queued tab operation was canceled.", "AbortError");
    if (signal?.aborted) return Promise.reject(reason());
    const previous = this.tails.get(tabId) || Promise.resolve();
    let started = false;
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const canceled = () => {
      if (!started) rejectResult(reason());
    };
    signal?.addEventListener("abort", canceled, { once: true });
    // The caller can stop waiting immediately, but this internal barrier must
    // still wait for earlier work before allowing later jobs into the tab.
    const execution = previous
      .catch(() => {})
      .then(() => {
        if (signal?.aborted) throw reason();
        started = true;
        signal?.removeEventListener("abort", canceled);
        return work();
      });
    void execution.then(
      (value) => {
        signal?.removeEventListener("abort", canceled);
        resolveResult(value);
      },
      (error) => {
        signal?.removeEventListener("abort", canceled);
        rejectResult(error);
      },
    );
    const tail = execution
      .catch(() => {})
      .finally(() => {
        if (this.tails.get(tabId) === tail) this.tails.delete(tabId);
      });
    this.tails.set(tabId, tail);
    return result;
  }
}
