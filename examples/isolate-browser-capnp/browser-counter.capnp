@0xe1c24ff9d2c3f001;

interface BrowserCounter {
  read @0 () -> (value :Int32);
  increment @1 (amount :Int32) -> (value :Int32);
  reset @2 () -> (value :Int32);
}
