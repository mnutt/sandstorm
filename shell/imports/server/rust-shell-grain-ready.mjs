// Observe the gateway's existing first-response signal, not the app's asset load.
// The caller supplies an already-authorized lease handle, never a browser selector.
export async function waitForGrainResponse(db, handle, signal, timeoutMs = 20000) {
  const ended = () => Object.assign(new Error('Grain session closed.'), {status:410});
  if (signal.aborted) throw ended();
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const aborted = () => finish(ended());
  const timer = setTimeout(() => finish({loaded:false}), timeoutMs);
  signal.addEventListener('abort', aborted, {once:true});
  let observation;
  let found = false;
  const changed = (_id, fields) => {
    if (fields.hasLoaded || fields.denied) finish({loaded:true});
  };
  try {
    observation = await db.collections.sessions.find({_id:handle.sessionId, rustShellSession:true},
      {fields:{hasLoaded:1,denied:1}}).observeChangesAsync({
      added(id, fields) { found = true; changed(id, fields); },
      changed,
      removed() { finish(ended()); },
    });
    if (!found) finish(ended());
    const result = await waiting;
    if (result instanceof Error) throw result;
    return result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', aborted);
    await observation?.stop();
  }
}
