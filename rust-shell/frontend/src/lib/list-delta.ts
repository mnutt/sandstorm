// Each subscription owns a cache. Never reuse it across queries or reconnects.
export class ListCache<T> {
  private rows = new Map<string, T>();
  private revision = 0n;
  constructor(private key: (row: T) => string) {}
  clear() { this.rows.clear(); this.revision = 0n; }
  apply(delta: {revision: bigint; reset: boolean; removed: Iterable<string>; order: Iterable<string>}, upserts: T[]): T[] {
    const invalid = () => { throw new Error('Invalid list update. Please reconnect.'); };
    if (delta.revision !== this.revision + 1n || delta.reset !== (this.revision === 0n)) invalid();
    const next = delta.reset ? new Map<string, T>() : new Map(this.rows);
    const touched = new Set<string>();
    for (const id of delta.removed) {
      if (delta.reset || !next.delete(id) || touched.has(id)) invalid();
      touched.add(id);
    }
    for (const row of upserts) {
      const id = this.key(row);
      if (!id || touched.has(id)) invalid();
      touched.add(id);
      next.set(id, row);
    }
    const order = [...delta.order];
    if (order.length !== next.size || new Set(order).size !== order.length || order.some(id => !next.has(id))) invalid();
    this.rows = next;
    this.revision = delta.revision;
    return order.map(id => next.get(id)!);
  }
}
