@0xf17a2d0e4c0b1a9d;

struct CorpusRecord {
  title @0 :Text;
  payload @1 :Data;
  count @2 :UInt64;
  offset @3 :Int32;
  enabled @4 :Bool;
  numbers @5 :List(UInt32);
  child @6 :Child;
  flavor @7 :Flavor;

  struct Child {
    label @0 :Text;
    score @1 :UInt16;
  }

  enum Flavor {
    alpha @0;
    beta @1;
    gamma @2;
  }
}
