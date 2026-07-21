import {
  NativeGreeter,
  NativeGreeterObjectId,
} from "capnp:./native-greeter.capnp";
import {
  createCapnpStruct,
  defineWorker,
  readCapnpStruct,
  serveCapnp,
} from "sandstorm:api";

const makeGreeter = () => ({
  async save() {
    return {
      objectId: createCapnpStruct(NativeGreeterObjectId, { id: "service-greeter" }),
      label: { defaultText: "service-only greeter" },
    };
  },
  async hello({ name }) {
    return { message: `service-only hello ${name}` };
  },
});

export default defineWorker({
  capabilities: {
    greeter: serveCapnp(NativeGreeter, makeGreeter(), {
      restore(objectId) {
        const parsed = readCapnpStruct(NativeGreeterObjectId, objectId);
        if (parsed.id !== "service-greeter") {
          throw new Error(`unknown service-only object ID: ${parsed.id}`);
        }
        return makeGreeter();
      },
      drop(objectId) {
        readCapnpStruct(NativeGreeterObjectId, objectId);
      },
    }),
  },
});
