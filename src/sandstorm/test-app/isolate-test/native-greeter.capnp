@0xf1e1ff1e4463b2c1;

using Grain = import "/sandstorm/grain.capnp";

struct NativeGreeterObjectId {
  id @0 :Text;
}

interface NativeGreetingListener {
  greeting @0 (message :Text);
}

interface NativeGreetingSubscription {
  close @0 ();
}

interface NativeGreeter extends(Grain.AppPersistent(NativeGreeterObjectId)) {
  hello @0 (name :Text) -> (message :Text);
  makeGreeter @1 (prefix :Text) -> (greeter :NativeGreeter);
  greetWith @2 (greeter :NativeGreeter, name :Text) -> (message :Text);
  inspectData @3 (content :Data) -> (byteCount :UInt64, checksum :UInt32, firstEightHex :Text);
  ping @4 (payload :Data) -> (payload :Data);
  storageRoundTrip @5 (key :Text, value :Data) -> (value :Data, listed :Bool);
  greetListener @6 (listener :NativeGreetingListener, name :Text)
      -> (subscription :NativeGreetingSubscription);
  notifyListeners @7 (message :Text) -> (count :UInt32);
  changeCounter @8 (delta :Int32) -> (value :Int64);
}
