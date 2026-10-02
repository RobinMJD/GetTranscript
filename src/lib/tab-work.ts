/** Serialize all operations that can change a player's controls or navigate its tab. */
export class TabWork {
  private tails = new Map<number, Promise<unknown>>();
  run<T>(tabId: number, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(tabId) || Promise.resolve();
    const result = previous.catch(() => {}).then(work);
    const tail = result
      .catch(() => {})
      .finally(() => {
        if (this.tails.get(tabId) === tail) this.tails.delete(tabId);
      });
    this.tails.set(tabId, tail);
    return result;
  }
}
