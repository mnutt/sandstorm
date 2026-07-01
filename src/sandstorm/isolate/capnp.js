import { RpcTarget } from "sandstorm:api";

export const SANDSTORM_CAPNP_VERSION = 0;

const bindingError = (interfaceName, operation) => new Error(
  `capnp:${interfaceName}.${operation} is not implemented yet for this schema binding.`
);

function requiredMethods(interfaceName, methods) {
  if (!methods || typeof methods !== "object") {
    throw new TypeError(`${interfaceName}.implement() requires a methods object`);
  }
  return methods;
}

function makeServerTarget(interfaceName, methodNames, methods) {
  const source = requiredMethods(interfaceName, methods);
  const target = new RpcTarget();
  for (const methodName of methodNames) {
    target[methodName] = async (...args) => {
      const method = source[methodName];
      if (typeof method !== "function") {
        throw new TypeError(`${interfaceName}.${methodName} is not implemented`);
      }
      return await method.apply(source, args);
    };
  }
  return target;
}

function makeClient(methodNames, caller, extras = {}) {
  const client = { ...extras };
  for (const methodName of methodNames) {
    client[methodName] = async (...args) => await caller(methodName, args);
  }
  return Object.freeze(client);
}

export function makeCapnpInterfaceBinding(interfaceName, methodNames, schema = {}) {
  const frozenMethodNames = Object.freeze([...methodNames]);
  return Object.freeze({
    interfaceName,
    schemaPath: schema.schemaPath || "",
    methodNames: frozenMethodNames,
    implement(methods) {
      return makeServerTarget(interfaceName, frozenMethodNames, methods);
    },
    cast(capability) {
      if (!capability || typeof capability !== "object" || !capability.rpc) {
        throw new TypeError(`${interfaceName}.cast() requires a Sandstorm capability`);
      }
      return makeClient(
        frozenMethodNames,
        (methodName, args) => capability.rpc[methodName](...args),
        {
          capability,
          drop: () => capability.drop(),
          save: (...args) => capability.save(...args),
        });
    },
    local(methods) {
      const source = requiredMethods(interfaceName, methods);
      return makeClient(frozenMethodNames, async (methodName, args) => {
        const method = source[methodName];
        if (typeof method !== "function") {
          throw new TypeError(`${interfaceName}.${methodName} is not implemented`);
        }
        return await method.apply(source, args);
      });
    },
    powerboxDescriptor() {
      throw bindingError(interfaceName, "powerboxDescriptor");
    },
  });
}
