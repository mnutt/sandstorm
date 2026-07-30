@0xf212915ce76fd001;

interface ObjectStore {
  listObjects @0 (bucket :Text, prefix :Text, cursor :Text)
      -> (objects :List(ObjectInfo), nextCursor :Text);

  openObject @1 (bucket :Text, key :Text)
      -> (object :StoredObject);

  struct ObjectInfo {
    key @0 :Text;
    size @1 :UInt64;
    contentType @2 :Text;
  }
}

interface StoredObject {
  read @0 () -> (body :Data, contentType :Text, eTag :Text);
}
