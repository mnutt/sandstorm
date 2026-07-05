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

function isNativeCapabilitySpec(caster) {
  return caster && typeof caster === "object" &&
    typeof caster.cast !== "function" &&
    typeof caster.nativeInterface === "string";
}

function nativeCapabilityValue(interfaceName, methodName, value, caster) {
  if (!value || typeof value !== "object" || typeof value.fetch !== "function") {
    throw new TypeError(
      `${interfaceName}.${methodName} result capability must be a Sandstorm ` +
      `${caster.nativeInterface} capability`);
  }
  return value;
}

function castCapabilityValue(interfaceName, methodName, caster, value, localMode) {
  if (isNativeCapabilitySpec(caster)) {
    return nativeCapabilityValue(interfaceName, methodName, value, caster);
  }

  const binding = resolveResultBinding(interfaceName, methodName, caster);
  if (value && typeof value === "object" && value.rpc) {
    return binding.cast(value);
  } else if (localMode) {
    return binding.local(value);
  } else {
    return binding.cast(value);
  }
}

function resultFieldEntries(spec) {
  if (!spec || typeof spec !== "object" || !spec.fields) return [];
  if (Array.isArray(spec.fields)) {
    return spec.fields;
  }
  return Object.entries(spec.fields);
}

async function castResult(interfaceName, methodName, result, resultCapabilities, localMode) {
  const spec = resultCapabilities[methodName];
  if (!spec) return result;

  if (typeof spec === "function" || typeof spec.cast === "function") {
    return castCapabilityValue(interfaceName, methodName, spec, result, localMode);
  }

  if (isNativeCapabilitySpec(spec)) {
    return nativeCapabilityValue(interfaceName, methodName, result, spec);
  }

  const fields = resultFieldEntries(spec);
  if (fields.length === 0 || !result || typeof result !== "object") {
    return result;
  }

  let casted = result;
  for (const [field, caster] of fields) {
    if (!Object.prototype.hasOwnProperty.call(result, field)) continue;
    if (casted === result) {
      casted = { ...result };
    }
    casted[field] = castCapabilityValue(
      interfaceName, methodName, caster, result[field], localMode);
  }
  return casted;
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
  const methodIds = Object.freeze({ ...(schema.methodIds || {}) });
  const paramStructIds = Object.freeze({ ...(schema.paramStructIds || {}) });
  const resultStructIds = Object.freeze({ ...(schema.resultStructIds || {}) });
  const schemaMetadata = Object.freeze({
    importSpecifier: schema.importSpecifier || "",
    interfaceName,
    interfaceId: schema.interfaceId || "",
    schemaPath: schema.schemaPath || "",
    schemaText: schema.schemaText || "",
    methodNames: frozenMethodNames,
    methodIds,
    paramStructIds,
    resultStructIds,
    argumentCapabilities,
    resultCapabilities,
  });
  return Object.freeze({
    interfaceName,
    interfaceId: schemaMetadata.interfaceId,
    schemaPath: schemaMetadata.schemaPath,
    schema: schemaMetadata,
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
