@0xd52aa98eb70f5b2c;

interface CounterListener {
  update @0 (value :Int64);
}

interface CounterSubscription {
  close @0 ();
}

interface Counter {
  read @0 () -> (value :Int64);
  change @1 (delta :Int32) -> (value :Int64);
  subscribe @2 (listener :CounterListener)
      -> (subscription :CounterSubscription);
}
