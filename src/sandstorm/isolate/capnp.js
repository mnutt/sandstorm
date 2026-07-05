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

function normalizeCapabilityPath(path) {
  const parts = typeof path === "string" ? path.split(".") : path;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new TypeError("capnp capability path must be a non-empty string or array");
  }
  return parts.map((part) => {
    if (typeof part !== "string" && typeof part !== "number") {
      throw new TypeError("capnp capability path segments must be strings or numbers");
    }
    return part;
  });
}

function isCapabilityLikeValue(value) {
  return value && typeof value === "object" &&
    (value.rpc || value.call || value.capability);
}

function mapCapabilityPathValue(value, path, mapper) {
  if (path.length === 0) {
    return mapper(value);
  }
  if (!value || typeof value !== "object" || isCapabilityLikeValue(value)) {
    return value;
  }

  const [field, ...rest] = path;
  if (!Object.prototype.hasOwnProperty.call(value, field)) {
    return value;
  }

  const nextFieldValue = mapCapabilityPathValue(value[field], rest, mapper);
  if (nextFieldValue === value[field]) {
    return value;
  }

  const nextValue = Array.isArray(value) ? [...value] : { ...value };
  nextValue[field] = nextFieldValue;
  return nextValue;
}

async function mapCapabilityPathValueAsync(value, path, mapper) {
  if (path.length === 0) {
    return await mapper(value);
  }
  if (!value || typeof value !== "object" || isCapabilityLikeValue(value)) {
    return value;
  }

  const [field, ...rest] = path;
  if (!Object.prototype.hasOwnProperty.call(value, field)) {
    return value;
  }

  const nextFieldValue = await mapCapabilityPathValueAsync(value[field], rest, mapper);
  if (nextFieldValue === value[field]) {
    return value;
  }

  const nextValue = Array.isArray(value) ? [...value] : { ...value };
  nextValue[field] = nextFieldValue;
  return nextValue;
}

function resultPathEntries(spec) {
  if (!spec || typeof spec !== "object") return [];
  const entries = [];
  const fields = spec.fields;
  if (Array.isArray(spec.fields)) {
    for (const [field, caster] of fields) {
      entries.push([normalizeCapabilityPath([field]), caster]);
    }
  } else if (fields && typeof fields === "object") {
    for (const [field, caster] of Object.entries(fields)) {
      entries.push([normalizeCapabilityPath([field]), caster]);
    }
  }

  const paths = spec.paths;
  if (Array.isArray(paths)) {
    for (const [path, caster] of paths) {
      entries.push([normalizeCapabilityPath(path), caster]);
    }
  } else if (paths && typeof paths === "object") {
    for (const [path, caster] of Object.entries(paths)) {
      entries.push([normalizeCapabilityPath(path), caster]);
    }
  }

  return entries;
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

  const paths = resultPathEntries(spec);
  if (paths.length === 0 || !result || typeof result !== "object") {
    return result;
  }

  let casted = result;
  for (const [path, caster] of paths) {
    casted = mapCapabilityPathValue(casted, path, (value) => castCapabilityValue(
      interfaceName, methodName, caster, value, localMode));
  }
  return casted;
}

function unwrapCapabilityArgument(value) {
  if (value && typeof value === "object" && value.capability) {
    return value.capability;
  }
  return value;
}

function declaredNativeInterface(spec) {
  if (!spec) return undefined;
  if (isNativeCapabilitySpec(spec)) return spec.nativeInterface;
  if (typeof spec === "function" || typeof spec.cast === "function") return "appObject";
  return undefined;
}

async function validateCapabilityArgument(interfaceName, methodName, value, spec) {
  const expected = declaredNativeInterface(spec);
  if (!expected) return;

  const capability = value?.capability || value;
  if (!capability || typeof capability !== "object" || typeof capability.info !== "function") {
    return;
  }

  const info = await capability.info();
  const actual = info?.nativeInterface || "unknown";
  if (actual !== expected) {
    throw new TypeError(
      `${interfaceName}.${methodName} argument capability nativeInterface ` +
      `${actual} does not match declared ${expected}`);
  }

  if (isNativeCapabilitySpec(spec) && spec.fetch && typeof capability.fetch !== "function") {
    throw new TypeError(
      `${interfaceName}.${methodName} argument capability must be fetch-shaped`);
  }
}

async function normalizeObjectCapabilityPaths(interfaceName, methodName, value, entries) {
  if (!value || typeof value !== "object" || value.rpc || value.call || value.capability) {
    return value;
  }

  let normalized = value;
  for (const [path, spec] of entries) {
    normalized = await mapCapabilityPathValueAsync(normalized, path, async (pathValue) => {
      await validateCapabilityArgument(interfaceName, methodName, pathValue, spec);
      return unwrapCapabilityArgument(pathValue);
    });
  }
  return normalized;
}

function argumentCapabilityPathEntries(spec) {
  const entries = [];
  const fields = spec.fields || [];
  if (Array.isArray(fields)) {
    for (const field of fields) {
      entries.push([normalizeCapabilityPath([field]), undefined]);
    }
  } else if (fields && typeof fields === "object") {
    for (const [field, fieldSpec] of Object.entries(fields)) {
      entries.push([normalizeCapabilityPath([field]), fieldSpec]);
    }
  }

  const paths = spec.paths || [];
  if (Array.isArray(paths)) {
    for (const pathEntry of paths) {
      if (Array.isArray(pathEntry) && pathEntry.length === 2 &&
          (Array.isArray(pathEntry[0]) || typeof pathEntry[0] === "string") &&
          (typeof pathEntry[1] === "function" || isNativeCapabilitySpec(pathEntry[1]) ||
           (pathEntry[1] && typeof pathEntry[1] === "object" &&
            typeof pathEntry[1].cast === "function"))) {
        entries.push([normalizeCapabilityPath(pathEntry[0]), pathEntry[1]]);
      } else {
        entries.push([normalizeCapabilityPath(pathEntry), undefined]);
      }
    }
  } else if (paths && typeof paths === "object") {
    for (const [path, pathSpec] of Object.entries(paths)) {
      entries.push([normalizeCapabilityPath(path), pathSpec]);
    }
  }
  return entries;
}

async function normalizeArgs(interfaceName, methodName, args, argumentCapabilities) {
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

  const paths = argumentCapabilityPathEntries(spec);
  if (paths.length > 0 && args.length === 1) {
    const nextValue = await normalizeObjectCapabilityPaths(
      interfaceName, methodName, normalized[0], paths);
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
      const normalizedArgs = await normalizeArgs(
        interfaceName, methodName, args, argumentCapabilities);
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
