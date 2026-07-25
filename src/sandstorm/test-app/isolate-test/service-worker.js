import {
  NativeGreeter,
  NativeGreeterObjectId,
} from "capnp:./native-greeter.capnp";
import {
  createCapnpStruct,
  defineWorker,
  readCapnpStruct,
  serveCapnp,
  storage,
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

  async storageRoundTrip({ key, value }, callContext) {
    const typedOnlyEnv = new Proxy(callContext.env, {
      get(target, property, receiver) {
        if (property === "STORAGE") {
          throw new Error("typed storage helper accessed the legacy Fetcher binding");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const store = storage(typedOnlyEnv);
    await store.put(key, value);
    const stored = await store.getBytes(key);
    const listing = await store.list();
    await store.delete(key);
    return {
      value: stored,
      listed: listing.keys.some((entry) => entry.name === key),
    };
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
