@0xb9b1b70b7e2b8c01;

using GreetingSchema = import "./greeting.capnp";

interface Greeter {
  hello @0 (name :Text) -> (message :Text);
  greeting @1 (name :Text) -> (greeting :GreetingSchema.Greeting);
  useGreeting @2 (greeting :GreetingSchema.Greeting) -> (message :Text);
}
