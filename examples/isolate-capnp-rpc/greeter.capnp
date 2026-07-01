@0xb9b1b70b7e2b8c01;

interface Greeter {
  hello @0 (name :Text) -> (message :Text);
  greeting @1 (name :Text) -> (greeting :Greeting);
  useGreeting @2 (greeting :Greeting) -> (message :Text);
}

interface Greeting {
  read @0 () -> (message :Text);
}
