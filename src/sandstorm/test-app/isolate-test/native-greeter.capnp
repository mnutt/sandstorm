@0xf1e1ff1e4463b2c1;

interface NativeGreeter {
  hello @0 (name :Text) -> (message :Text);
  makeGreeter @1 (prefix :Text) -> (greeter :NativeGreeter);
  greetWith @2 (greeter :NativeGreeter, name :Text) -> (message :Text);
}
