// The memory implementation is used by standalone fixtures. Production supplies
// a private Mongo adapter; neither store ever receives the raw bearer token.
export function memorySessionStore() {
  const rows = new Map();
  return {
    get: async key => rows.get(key),
    put: async (key, record) => { rows.set(key, { ...record }); },
    remove: async key => { rows.delete(key); },
    prune: async now => { for (const [key, row] of rows) if (row.expires <= now) rows.delete(key); },
    count: async () => rows.size,
  };
}

export function mongoSessionStore(collection) {
  const available = fn => async (...args) => {
    try { return await fn(...args); }
    catch { throw Object.assign(new Error("The main shell is temporarily unavailable."), { status: 503 }); }
  };
  return {
    get: available(key => collection.findOneAsync({ _id: key })),
    put: available((key, record) => collection.insertAsync({ _id: key, ...record, expiresAt: new Date(record.expires) })),
    remove: available(key => collection.removeAsync({ _id: key })),
    prune: available(now => collection.removeAsync({ expires: { $lte: now } })),
    count: available(() => collection.find({}).countAsync()),
  };
}
