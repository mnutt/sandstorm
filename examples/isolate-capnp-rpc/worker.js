import { sandstorm } from "sandstorm:api";
import { Greeter } from "capnp:./greeter.capnp";

const greeterMethods = {
  async hello({ name = "world" } = {}) {
    return { message: `Hello, ${name}` };
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

    return Response.json({
      ok: true,
      interfaceName: Greeter.interfaceName,
      methodNames: Greeter.methodNames,
      result,
    });
  },
};
