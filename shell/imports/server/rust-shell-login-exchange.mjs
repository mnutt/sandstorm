// A timeout ends the caller's wait, not an in-flight Meteor method. Keep the
// private connection alive until that method replies, so late tokens can be
// revoked. No new methods or local writes may start after cancellation.
export async function loginExchange({open, revoke, signal, timeout = 15000,
  timeoutError = () => new Error("Sign-in timed out. Check before trying again.")}, operation) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, {once:true});
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(timeoutError()), timeout);
  const tokens = new Set();
  let retained, committed = false, connection;
  const check = () => controller.signal.throwIfAborted();
  const cancellation = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {once:true});
    if (controller.signal.aborted) reject(controller.signal.reason);
  });
  const dispose = async () => {
    for (const token of tokens) {
      if (committed && token === retained) continue;
      await revoke(token);
      tokens.delete(token);
    }
  };
  const work = (async () => {
    let succeeded = false;
    try {
      check();
      const opened = await open();
      connection = opened.connection;
      await Promise.race([opened.ready, cancellation]);
      check();
      const value = await operation({
        check,
        call: async (method, ...args) => {
          check();
          const result = await connection.applyAsync(method,args,{noRetry:true,returnServerResultPromise:true});
          // Capture ownership before checking the deadline, including late results.
          if (result?.id && result?.token) tokens.add(result);
          check();
          return result;
        },
        retain: token => { check(); retained = token; },
      });
      check();
      succeeded = true;
      return value;
    } finally {
      connection?.close();
      for (const token of tokens) {
        if (succeeded && !controller.signal.aborted && token === retained) continue;
        await revoke(token);
        tokens.delete(token);
      }
    }
  })();
  try {
    const value = await Promise.race([work, cancellation]);
    check();
    return {value, commit() { check(); committed = true; }, dispose};
  } catch (error) {
    // Cleanup also runs when an already-started method settles after our caller
    // has gone away. Attach a handler immediately to avoid unhandled rejection.
    void work.catch(() => {}).then(dispose).catch(error => console.error("Login cleanup failed", error));
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
