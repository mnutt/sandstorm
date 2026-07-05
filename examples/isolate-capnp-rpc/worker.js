import { sandstorm } from "sandstorm:api";
import { Greeting } from "capnp:./greeting.capnp";
import { Greeter } from "capnp:./greeter.capnp";

const greeterMethods = {
  async hello({ name = "world" } = {}) {
    return { message: `Hello, ${name}` };
  },
  async greeting({ name = "world" } = {}) {
    return Greeting.implement({
      async read() {
        return { message: `Hello, ${name}` };
      },
    });
  },
  async greetingPair({ name = "world" } = {}) {
    return {
      formal: Greeting.implement({
        async read() {
          return { message: `Hello, ${name}` };
        },
      }),
      casual: Greeting.implement({
        async read() {
          return { message: `Hi, ${name}` };
        },
      }),
    };
  },
  async useGreeting(greeting) {
    if (typeof greeting.call === "function") {
      return greeting.call("read");
    }
    return greeting.read();
  },
};

export default {
  async fetch(request, env) {
    const api = sandstorm(request, env, {
      capabilities: {
        greeter: Greeter.implement(greeterMethods),
      },
    });

    const system = await api.serveSystemRoutes();
    if (system) return system;

    const url = new URL(request.url);
    const greeter = Greeter.local(greeterMethods);
    const result = await greeter.hello({
      name: url.searchParams.get("name") || "isolate",
    });
    const greeting = await greeter.greeting({
      name: url.searchParams.get("name") || "isolate",
    });
    const greetingPair = await greeter.greetingPair({
      name: url.searchParams.get("name") || "isolate",
    });
    const greetingResult = await greeting.read();
    const formalGreetingResult = await greetingPair.formal.read();
    const casualGreetingResult = await greetingPair.casual.read();
    const useGreetingResult = await greeter.useGreeting(greeting);

    return Response.json({
      ok: true,
      interfaceName: Greeter.interfaceName,
      methodNames: Greeter.methodNames,
      result,
      greetingResult,
      formalGreetingResult,
      casualGreetingResult,
      useGreetingResult,
    });
  },
};
