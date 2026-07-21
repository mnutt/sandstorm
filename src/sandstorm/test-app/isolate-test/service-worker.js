import { NativeGreeter } from "capnp:./native-greeter.capnp";
import { defineWorker, serveCapnp } from "sandstorm:api";

const greeter = {
  async hello({ name }) {
    return { message: `service-only hello ${name}` };
  },
};

export default defineWorker({
  capabilities: {
    greeter: serveCapnp(NativeGreeter, greeter),
  },
});
