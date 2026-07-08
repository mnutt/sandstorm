@0xf1e1ff1e4463b2c1;

using Grain = import "/sandstorm/grain.capnp";

struct NativeGreeterObjectId {
  id @0 :Text;
}

interface NativeGreeter extends(Grain.AppPersistent(NativeGreeterObjectId)) {
  hello @0 (name :Text) -> (message :Text);
  makeGreeter @1 (prefix :Text) -> (greeter :NativeGreeter);
  greetWith @2 (greeter :NativeGreeter, name :Text) -> (message :Text);
}
