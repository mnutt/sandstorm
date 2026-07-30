@0x9db00f2d4d7c0a51;

using Grain = import "/sandstorm/grain.capnp";

struct ObjectStoreObjectId {
  type @0 :Text;
  bucket @1 :Text;
  prefix @2 :Text;
}

interface ObjectStore {
  listObjects @0 (bucket :Text, prefix :Text, cursor :Text)
      -> (objects :List(ObjectInfo), nextCursor :Text);

  uploadTarget @1 (bucket :Text, prefix :Text)
      -> (target :ObjectUploadTarget);

  struct ObjectInfo {
    key @0 :Text;
    size @1 :UInt64;
    contentType @2 :Text;
  }
}

interface ObjectUploadTarget extends(Grain.AppPersistent(ObjectStoreObjectId)) {
  putObject @0 (key :Text, contentType :Text, data :Data) -> (size :UInt64);
}
