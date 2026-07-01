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

function resolveResultBinding(interfaceName, methodName, caster) {
  const binding = typeof caster === "function" ? caster() : caster;
  if (!binding || typeof binding !== "object" || typeof binding.cast !== "function") {
    throw new TypeError(
      `${interfaceName}.${methodName} result capability caster must be a capnp interface binding`);
  }
  return binding;
}

async function castResult(interfaceName, methodName, result, resultCapabilities, localMode) {
  const caster = resultCapabilities[methodName];
  if (!caster) return result;
  const binding = resolveResultBinding(interfaceName, methodName, caster);
  if (result && typeof result === "object" && result.rpc) {
    return binding.cast(result);
  } else if (localMode) {
    return binding.local(result);
  } else {
    return binding.cast(result);
  }
}

function unwrapCapabilityArgument(value) {
  if (value && typeof value === "object" && value.capability) {
    return value.capability;
  }
  return value;
}

function normalizeObjectCapabilityFields(value, fields) {
  if (!value || typeof value !== "object" || value.rpc || value.call || value.capability) {
    return value;
  }

  let normalized = value;
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      const nextValue = unwrapCapabilityArgument(value[field]);
      if (nextValue !== value[field]) {
        if (normalized === value) {
          normalized = { ...value };
        }
        normalized[field] = nextValue;
      }
    }
  }
  return normalized;
}

function normalizeArgs(methodName, args, argumentCapabilities) {
  const spec = argumentCapabilities[methodName];
  if (!spec) return args;

  let normalized = args;
  const indexes = spec.indexes || spec.indices || [];
  for (const index of indexes) {
    if (Number.isInteger(index) && index >= 0 && index < args.length) {
      const nextValue = unwrapCapabilityArgument(args[index]);
      if (nextValue !== args[index]) {
        if (normalized === args) {
          normalized = [...args];
        }
        normalized[index] = nextValue;
      }
    }
  }

  const fields = spec.fields || [];
  if (fields.length > 0 && args.length === 1) {
    const nextValue = normalizeObjectCapabilityFields(normalized[0], fields);
    if (nextValue !== normalized[0]) {
      if (normalized === args) {
        normalized = [...args];
      }
      normalized[0] = nextValue;
    }
  }

  return normalized;
}

function makeClient(
    interfaceName, methodNames, argumentCapabilities, resultCapabilities, caller, options = {}) {
  const client = { ...(options.extras || {}) };
  const localMode = Boolean(options.local);
  for (const methodName of methodNames) {
    client[methodName] = async (...args) => {
      const normalizedArgs = normalizeArgs(methodName, args, argumentCapabilities);
      const result = await caller(methodName, normalizedArgs);
      return await castResult(interfaceName, methodName, result, resultCapabilities, localMode);
    };
  }
  return Object.freeze(client);
}

export function makeCapnpInterfaceBinding(interfaceName, methodNames, schema = {}) {
  const frozenMethodNames = Object.freeze([...methodNames]);
  const argumentCapabilities = Object.freeze({ ...(schema.argumentCapabilities || {}) });
  const resultCapabilities = Object.freeze({ ...(schema.resultCapabilities || {}) });
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
        interfaceName,
        frozenMethodNames,
        argumentCapabilities,
        resultCapabilities,
        (methodName, args) => capability.rpc[methodName](...args),
        {
          extras: {
            capability,
            drop: () => capability.drop(),
            save: (...args) => capability.save(...args),
          },
        });
    },
    local(methods) {
      const source = requiredMethods(interfaceName, methods);
      return makeClient(
        interfaceName,
        frozenMethodNames,
        argumentCapabilities,
        resultCapabilities,
        async (methodName, args) => {
          const method = source[methodName];
          if (typeof method !== "function") {
            throw new TypeError(`${interfaceName}.${methodName} is not implemented`);
          }
          return await method.apply(source, args);
        },
        { local: true });
    },
    powerboxDescriptor() {
      throw bindingError(interfaceName, "powerboxDescriptor");
    },
  });
}
