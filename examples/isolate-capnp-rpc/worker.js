import { sandstorm } from "sandstorm:api";
import { exportNativeCapnp } from "sandstorm:capnp";
import { Greeting } from "capnp:./greeting.capnp";
import { Greeter } from "capnp:./greeter.capnp";

function makeGreeting(message) {
  return new Greeting.Server({
    async read() {
      return { message };
    },
  }).client();
}

const greeterMethods = {
  async hello({ name = "world" } = {}) {
    return { message: `Hello, ${name}` };
  },
  async greeting({ name = "world" } = {}) {
    return { greeting: makeGreeting(`Hello, ${name}`) };
  },
  async greetingPair({ name = "world" } = {}) {
    return {
      formal: makeGreeting(`Hello, ${name}`),
      casual: makeGreeting(`Hi, ${name}`),
    };
  },
  async useGreeting({ greeting } = {}) {
    const result = await greeting.read();
    return { message: result.message };
  },
};

export default {
  async fetch(request, env) {
    const api = sandstorm(request, env);

    const system = await api.serveSystemRoutes();
    if (system) return system;

    const url = new URL(request.url);
    if (url.pathname === "/export-greeter") {
      const capability = await exportNativeCapnp(api, Greeter, greeterMethods, {
        interfaceName: "Greeter",
      });
      return Response.json({
        ok: true,
        capability,
        info: await capability.info(),
      });
    }

    const greeter = new Greeter.Server(greeterMethods).client();
    const result = await greeter.hello({
      name: url.searchParams.get("name") || "isolate",
    });
    const greeting = await greeter.greeting({
      name: url.searchParams.get("name") || "isolate",
    });
    const greetingPair = await greeter.greetingPair({
      name: url.searchParams.get("name") || "isolate",
    });
    const greetingResult = await greeting.greeting.read();
    const formalGreetingResult = await greetingPair.formal.read();
    const casualGreetingResult = await greetingPair.casual.read();
    const useGreetingResult = await greeter.useGreeting({
      greeting: greeting.greeting,
    });
    await greeter.drop?.();

    return Response.json({
      ok: true,
      interfaceName: Greeter.interfaceName || "Greeter",
      interfaceId: `0x${Greeter._capnp.typeIdHex}`,
      result,
      greetingResult,
      formalGreetingResult,
      casualGreetingResult,
      useGreetingResult,
    });
  },
};
