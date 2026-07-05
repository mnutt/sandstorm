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
    const greetingResult = await greeting.read();
    const useGreetingResult = await greeter.useGreeting(greeting);

    return Response.json({
      ok: true,
      interfaceName: Greeter.interfaceName,
      methodNames: Greeter.methodNames,
      result,
      greetingResult,
      useGreetingResult,
    });
  },
};
