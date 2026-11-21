@0xc9221ec192294517;

# Deliberately separate from Sandstorm's privileged Backend interface.
interface Fixture {
  newCounter @0 (initial :UInt32) -> (counter :Counter);
  inspect @1 () -> (liveCounters :UInt32, liveStreams :UInt32, sentChunks :UInt32);
}

interface Counter {
  add @0 (amount :UInt32) -> (value :UInt32);
  report @1 (observer :CounterObserver) -> ();
  fail @2 () -> ();
  stream @3 (sink :ByteSink, count :UInt32, chunkBytes :UInt32) -> (stream :Stream);
}

interface CounterObserver {
  changed @0 (value :UInt32) -> ();
}

interface ByteSink {
  # One call in flight. Acknowledgment permits the next chunk; no pipelined writes.
  write @0 (sequence :UInt32, data :Data) -> ();
  done @1 (count :UInt32) -> ();
}

interface Stream {
  cancel @0 () -> ();
  # Release or disconnect also cancels; explicit cancel retains this handle.
}
