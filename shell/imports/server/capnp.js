// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2017 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import fs from "fs";
import net from "net";
import os from "os";
import path from "path";

import * as capnp from "capnp-es";
import { transportFromDuplex } from "capnp-es/dist/node/index.mjs";

import * as Activity from "./capnp-es/generated/sandstorm/activity";
import * as ApiSession from "./capnp-es/generated/sandstorm/api-session";
import * as ApiSessionImpl from "./capnp-es/generated/sandstorm/api-session-impl";
import * as Backend from "./capnp-es/generated/sandstorm/backend";
import * as Email from "./capnp-es/generated/sandstorm/email";
import * as EmailImpl from "./capnp-es/generated/sandstorm/email-impl";
import * as Grain from "./capnp-es/generated/sandstorm/grain";
import * as HackSession from "./capnp-es/generated/sandstorm/hack-session";
import * as Identity from "./capnp-es/generated/sandstorm/identity";
import * as IdentityImpl from "./capnp-es/generated/sandstorm/identity-impl";
import * as Ip from "./capnp-es/generated/sandstorm/ip";
import * as Payments from "./capnp-es/generated/sandstorm/payments";
import * as PersistentUiView from "./capnp-es/generated/sandstorm/persistentuiview";
import * as Powerbox from "./capnp-es/generated/sandstorm/powerbox";
import * as Supervisor from "./capnp-es/generated/sandstorm/supervisor";
import * as TestApp from "./capnp-es/generated/sandstorm/test-app/test-app";
import * as Util from "./capnp-es/generated/sandstorm/util";
import * as WebSession from "./capnp-es/generated/sandstorm/web-session";

const CAPNP_ES_DISPOSE = Symbol.for("capnp-es.dispose");

const SCHEMAS = {
  "sandstorm/activity.capnp": Activity,
  "sandstorm/api-session.capnp": ApiSession,
  "sandstorm/api-session-impl.capnp": ApiSessionImpl,
  "sandstorm/backend.capnp": Backend,
  "sandstorm/email.capnp": Email,
  "sandstorm/email-impl.capnp": EmailImpl,
  "sandstorm/grain.capnp": {
    ...Grain,
    minimumSchedulingSlack: 300000000000,
  },
  "sandstorm/hack-session.capnp": HackSession,
  "sandstorm/identity.capnp": Identity,
  "sandstorm/identity-impl.capnp": IdentityImpl,
  "sandstorm/ip.capnp": Ip,
  "sandstorm/payments.capnp": Payments,
  "sandstorm/persistentuiview.capnp": PersistentUiView,
  "sandstorm/powerbox.capnp": Powerbox,
  "sandstorm/supervisor.capnp": Supervisor,
  "sandstorm/test-app/test-app.capnp": TestApp,
  "sandstorm/util.capnp": Util,
  "sandstorm/web-session.capnp": WebSession,
};

WebSession.WebSession.Context.headerWhitelist = [
  "x-sandstorm-app-*",
  "oc-total-length",
  "oc-chunk-size",
  "x-oc-mtime",
  "oc-fileid",
  "oc-chunked",
  "oc-checksum",
  "oc-chunk-offset",
  "oc-lazyops",
  "x-hgarg-*",
  "x-phabricator-*",
  "x-requested-with",
  "x-csrftoken",
  "x-csrf-token",
];
WebSession.WebSession.Response.headerWhitelist = [
  "x-sandstorm-app-*",
  "x-oc-mtime",
];

const MODULES = Object.values(SCHEMAS);
const interfaceByTypeId = new Map();
const enumByDisplayName = new Map();
const CAPNP_DEBUG_ENABLED = !!process.env.CAPNP_ES_DEBUG;
const sortedFieldsCache = new WeakMap();
const wrappedClientMethodCache = new WeakMap();
const capitalizedFieldNameCache = new WeakMap();
const enumNameCache = new WeakMap();
const structConverterCache = new WeakMap();
const fieldValueConverterCache = new WeakMap();
let nextCapabilityStreamId = 0;
let nextRpcDebugId = 0;

const CAPNP_DEBUG_METHODS = new Set([
  "getMainView",
  "getViewInfo",
  "newSession",
  "newRequestSession",
  "addRequirements",
  "schedule",
  "save",
]);

for (const module of MODULES) {
  for (const [name, value] of Object.entries(module)) {
    addTypeIdAliases(value);
    if (value && value.Client && value.Server && value._capnp?.typeId !== undefined) {
      interfaceByTypeId.set(value._capnp.typeId, value);
    } else if (isEnumObject(value)) {
      enumByDisplayName.set(name, value);
      for (const alias of enumDisplayNameAliases(name)) {
        if (!enumByDisplayName.has(alias)) enumByDisplayName.set(alias, value);
      }
    }
  }
}

function addTypeIdAliases(value) {
  if (!value || value._capnp?.typeId === undefined) return;
  if (value.typeId === undefined) value.typeId = value._capnp.typeId;
  if (value.typeIdHex === undefined) value.typeIdHex = value._capnp.typeIdHex;
}

class Capability {
  constructor(target, InterfaceClass) {
    const serverTarget = makeServerTarget(target, InterfaceClass);
    const client = new InterfaceClass.Server(serverTarget).client();
    return new WrappedClient(InterfaceClass, client, serverTarget);
  }
}

class WrappedClient {
  constructor(InterfaceClass, client, serverTarget, shared) {
    const generatedClient = normalizeClient(InterfaceClass, client);
    this._interfaceClass = InterfaceClass;
    this._client = generatedClient;
    this._serverTarget = serverTarget;
    this._closed = false;
    this._shared = shared || { client: rawClientOf(generatedClient), refs: 1, closed: false };
    this.client = this._shared.client;

    for (const [name, fn] of wrappedClientMethods(InterfaceClass)) {
      this[name] = fn;
    }
  }

  castAs(InterfaceClass) {
    retainSharedClient(this._shared);
    return wrapClient(InterfaceClass, new InterfaceClass.Client(this.client), this._shared);
  }

  close() {
    closeSharedClient(this);
  }
}

function wrappedClientMethods(InterfaceClass) {
  let methods = wrappedClientMethodCache.get(InterfaceClass);
  if (methods) return methods;

  methods = InterfaceClass.Client.methods.map((method) => [
    method.methodName,
    function wrappedCapnpMethod(...args) {
      return callMethod(this, method, args);
    },
  ]);

  wrappedClientMethodCache.set(InterfaceClass, methods);
  return methods;
}

class Connection {
  constructor(conn) {
    this._conn = conn;
  }

  restore(_id, InterfaceClass) {
    return wrapClient(InterfaceClass, this._conn.bootstrap(InterfaceClass));
  }

  close() {
    this._conn.shutdown();
  }
}

function importSystem(path) {
  const schema = SCHEMAS[path];
  if (!schema) {
    throw new Error(`Unknown capnp schema: ${path}`);
  }

  return schema;
}

function connect(address, bootstrapCap) {
  const conn = new capnp.Conn(transportFromAddress(address));
  if (bootstrapCap?._serverTarget) {
    conn.initMain(bootstrapCap._interfaceClass, bootstrapCap._serverTarget);
  }

  return new Connection(conn);
}

function serialize(StructClass, value) {
  const message = new capnp.Message();
  const root = message.initRoot(StructClass);
  fillStruct(root, value);
  return Buffer.from(message.toArrayBuffer());
}

function serializePacked(StructClass, value) {
  const message = new capnp.Message();
  const root = message.initRoot(StructClass);
  fillStruct(root, value);
  return Buffer.from(message.toPackedArrayBuffer());
}

function parse(StructClass, buffer, options = {}) {
  return structToPlain(new capnp.Message(buffer, !!options.packed).getRoot(StructClass));
}

function matchPowerboxQuery(query, candidate, tagId) {
  if (!query || query.length === 0) return true;
  if (!candidate || candidate.length === 0) return false;

  const InterfaceClass = interfaceByTypeId.get(normalizeTypeId(tagId));
  const PowerboxTag = InterfaceClass && InterfaceClass.PowerboxTag;
  if (PowerboxTag) {
    return plainObjectContains(parse(PowerboxTag, candidate), parse(PowerboxTag, query));
  }

  return Buffer.compare(Buffer.from(query), Buffer.from(candidate)) === 0;
}

function normalizeTypeId(typeId) {
  if (typeId === undefined || typeId === null) return undefined;
  if (typeof typeId === "bigint") return typeId;
  return BigInt(typeId);
}

function plainObjectContains(candidate, query) {
  if (query === undefined) return true;
  if (candidate === undefined) return false;
  if (Buffer.isBuffer(query) || query instanceof Uint8Array) {
    return Buffer.compare(Buffer.from(query), Buffer.from(candidate || [])) === 0;
  }
  if (Array.isArray(query)) {
    return Array.isArray(candidate) &&
        query.length === candidate.length &&
        query.every((value, index) => plainObjectContains(candidate[index], value));
  }
  if (query && typeof query === "object") {
    if (!candidate || typeof candidate !== "object") return false;
    return Object.entries(query).every(([key, value]) => plainObjectContains(candidate[key], value));
  }

  return candidate === query;
}

function proxyClient(client, InterfaceClass) {
  const target = {};
  for (const method of InterfaceClass.Client.methods) {
    target[method.methodName] = (...args) => client[method.methodName](...args);
  }

  return new Capability(target, InterfaceClass);
}

function makeServerTarget(target, InterfaceClass) {
  const serverTarget = {};
  const hasCloseMethod = InterfaceClass.Client.methods.some((method) => method.methodName === "close");

  if (!hasCloseMethod && typeof target.close === "function") {
    serverTarget[CAPNP_ES_DISPOSE] = () => target.close();
  }

  for (const method of InterfaceClass.Client.methods) {
    serverTarget[method.methodName] = async (params, results) => {
      const impl = target[method.methodName];
      if (typeof impl !== "function") {
        throw new capnp.CapnpRpcError(`Method not implemented: ${method.methodName}`, {
          code: "unimplemented",
        });
      }

      const args = paramsToMethodArgs(params, method);
      try {
        const value = await impl.apply(target, args);
        if (value !== undefined) {
          fillStruct(results, value);
        }
      } catch (err) {
        console.error("Exception while serving capnp method", methodLabel(method),
            err && err.stack || err);
        throw err;
      }
    };
  }

  return serverTarget;
}

function callMethod(wrapped, method, args) {
  const debugId = shouldDebugMethod(method) ? nextRpcDebugId++ : null;
  const startedAt = Date.now();
  if (debugId !== null) {
    console.log("[capnp-es rpc]", debugId, "call.start", methodLabel(method));
  }

  const call = { method };
  if (args.length > 0) {
    call.paramsFunc = (params) => {
      fillStructFromArgs(params, method.ParamsClass._capnp.fields, args);
    };
  }

  const answer = wrapped.client.call(call);
  return new ResultPromise(method.ResultsClass, answer, method, debugId, startedAt);
}

class ResultPromise {
  constructor(ResultsClass, answer, method, debugId, startedAt) {
    this._ResultsClass = ResultsClass;
    this._answer = answer;
    this._method = method;
    this._debugId = debugId;
    this._startedAt = startedAt;
    this._pipeline = null;
    this._plainPromise = null;

    for (const field of ResultsClass._capnp.fields) {
      const isInterface = field.type?.kind === "interface";
      const isCapability = field.type?.kind === "anyPointer" && field.name === "cap";
      if (!isInterface && !isCapability) continue;
      Object.defineProperty(this, field.name, {
        enumerable: true,
        get: () => {
          if (isCapability) {
            return wrapClient(Supervisor.SystemPersistent,
                this.pipeline().getPipeline(Supervisor.SystemPersistent, field.offset)
                  .client());
          } else {
            const InterfaceClass = interfaceByTypeId.get(field.type.typeId);
            if (!InterfaceClass) throw new Error(`No pipeline getter for result field: ${field.name}`);

            if (this._debugId !== null) {
              console.log("[capnp-es rpc]", this._debugId, "pipeline.get", field.name,
                  "->", InterfaceClass._capnp?.displayName || field.type.displayName);
            }
            return wrapClient(InterfaceClass, this.pipeline().getPipeline(InterfaceClass, field.offset).client());
          }
        },
      });
    }
  }

  pipeline() {
    if (!this._pipeline) {
      this._pipeline = new capnp.Pipeline(this._ResultsClass, this._answer);
    }

    return this._pipeline;
  }

  then(onFulfilled, onRejected) {
    return this.promise().then(onFulfilled, onRejected);
  }

  catch(onRejected) {
    return this.promise().catch(onRejected);
  }

  finally(onFinally) {
    return this.promise().finally(onFinally);
  }

  promise() {
    if (!this._plainPromise) this._plainPromise = this.resolvePlain();
    return this._plainPromise;
  }

  async resolvePlain() {
    try {
      const value = structToPlain(await this._answer.struct());
      if (this._debugId !== null) {
        console.log("[capnp-es rpc]", this._debugId, "call.done",
            methodLabel(this._method), Date.now() - this._startedAt + "ms");
      }
      return value;
    } catch (err) {
      const decorated = decorateRpcError(err);
      if (this._debugId !== null) {
        console.log("[capnp-es rpc]", this._debugId, "call.error",
            methodLabel(this._method), Date.now() - this._startedAt + "ms",
            JSON.stringify({
              kjType: decorated && decorated.kjType,
              code: decorated && decorated.code,
              message: decorated && decorated.message,
            }));
      }
      throw decorated;
    }
  }
}

function shouldDebugMethod(method) {
  if (!CAPNP_DEBUG_ENABLED) return false;
  if (method.interfaceName === "sandstorm/web-session.capnp:WebSession") return true;
  return CAPNP_DEBUG_METHODS.has(method.methodName);
}

function methodLabel(method) {
  return `${method.interfaceName}:${method.methodName}`;
}

function decorateRpcError(err) {
  if (err && typeof err === "object" && err.kjType === undefined &&
      typeof err.code === "string") {
    err.kjType = err.code;
  }

  return err;
}

function wrapClient(InterfaceClass, client, shared) {
  return new WrappedClient(InterfaceClass, client, undefined, shared);
}

function normalizeClient(InterfaceClass, client) {
  if (client instanceof WrappedClient) return new InterfaceClass.Client(client.client);
  if (isGeneratedClient(client)) return client;
  if (typeof client?.call === "function") return new InterfaceClass.Client(client);
  return client;
}

function rawClientOf(client) {
  const rawClient = client?.client;
  if (!rawClient || typeof rawClient === "function" || typeof rawClient.call !== "function") {
    throw new Error("Cannot wrap capnp client without an RPC client");
  }
  return rawClient;
}

function isGeneratedClient(value) {
  return !!value?.client && typeof value.client !== "function" &&
      typeof value.client.call === "function";
}

function retainSharedClient(shared) {
  if (!shared.closed) shared.refs++;
}

function closeSharedClient(wrapped) {
  if (wrapped._closed) return;
  wrapped._closed = true;

  const shared = wrapped._shared;
  if (shared.closed) return;
  shared.refs--;
  if (shared.refs > 0) return;

  shared.closed = true;
  try {
    shared.client.close();
  } catch (err) {
    if (!isExpectedCloseError(err)) throw err;
  }
}

function isExpectedCloseError(err) {
  const message = String(err?.message || "");
  return message.includes("pipeline closed") ||
      message.includes("already closed") ||
      message.includes("Called null capability") ||
      message.includes("Peer disconnected") ||
      message.includes("capability has been revoked");
}

function transportFromAddress(address) {
  if (typeof address === "string") {
    if (address.startsWith("unix:")) {
      return transportFromDuplex(net.createConnection(address.slice("unix:".length)));
    }

    throw new Error(`Unsupported capnp address: ${address}`);
  }

  if (address?.capabilityStreamFd !== undefined) {
    return transportFromDuplex(connectViaCapabilityStreamFd(address.capabilityStreamFd));
  }

  throw new Error(`Unsupported capnp address: ${JSON.stringify(address)}`);
}

function connectViaCapabilityStreamFd(fd) {
  const socketPath = path.join(
    os.tmpdir(),
    `sandstorm-capnp-es-${process.pid}-${nextCapabilityStreamId++}.sock`,
  );
  const client = new net.Socket();
  const server = net.createServer((accepted) => {
    server.close();
    fs.unlink(socketPath, () => {});
    sendSocketOverCapabilityStream(fd, accepted).finally(() => accepted.destroy());
  });

  const fail = (err) => {
    client.destroy(err);
    server.close();
    fs.unlink(socketPath, () => {});
  };
  server.once("error", fail);
  server.listen(socketPath);
  client.connect(socketPath);

  return client;
}

function sendSocketOverCapabilityStream(fd, socket) {
  const { Pipe, constants: PipeConstants } = process.binding("pipe_wrap");
  const { WriteWrap, kLastWriteWasAsync, streamBaseState } = process.binding("stream_wrap");
  const pipe = new Pipe(PipeConstants.IPC);
  pipe.open(fd);

  return new Promise((resolve, reject) => {
    const closePipe = () => {
      try {
        pipe.close();
      } catch (_err) {
        // The pipe may already be closed if the peer raced us.
      }
    };
    const req = new WriteWrap();
    req.oncomplete = (status) => {
      closePipe();
      if (status) {
        reject(new Error(`failed to send capability stream fd: ${status}`));
      } else {
        resolve();
      }
    };

    const err = pipe.writeBuffer(req, Buffer.from([0]), socket._handle);
    if (err) {
      closePipe();
      reject(new Error(`failed to send capability stream fd: ${err}`));
    } else if (!streamBaseState[kLastWriteWasAsync]) {
      closePipe();
      process.nextTick(resolve);
    }
  });
}

function paramsToArgs(params, fields) {
  return sortedFields(fields).map((field) => fieldToPlain(params, field));
}

function paramsToMethodArgs(params, method) {
  const paramsName = method.ParamsClass?._capnp?.displayName || "";
  if (!paramsName.endsWith("$Params")) {
    return [structToPlain(params)];
  }

  return paramsToArgs(params, method.ParamsClass._capnp.fields);
}

function fillStructFromArgs(struct, fields, args) {
  sortedFields(fields).forEach((field, index) => {
    if (index < args.length) {
      setField(struct, field, args[index]);
    }
  });
}

function fillStruct(struct, value) {
  if (!value) return;
  for (const field of sortedFields(struct.constructor._capnp.fields || [])) {
    if (Object.prototype.hasOwnProperty.call(value, field.name)) {
      setField(struct, field, value[field.name]);
    } else if (field.name === "permissions" &&
        Object.prototype.hasOwnProperty.call(value, "permissionSet")) {
      setField(struct, field, value.permissionSet);
    }
  }
}

function setField(struct, field, value) {
  if (value === undefined) return;
  if (value === null && field.type?.kind !== "void") return;

  switch (field.type?.kind) {
    case "anyPointer": {
      setAnyPointer(struct, field, value);
      return;
    }

    case "data": {
      const data = struct[`_init${capitalizedFieldName(field)}`](value.length);
      data.copyBuffer(Buffer.from(value));
      return;
    }

    case "enum": {
      struct[field.name] = enumValue(field.type.displayName, value);
      return;
    }

    case "interface": {
      struct[field.name] = interfaceValueForField(field, value);
      return;
    }

    case "list": {
      if (value && value.array instanceof Array) value = value.array;
      const list = struct[`_init${capitalizedFieldName(field)}`](value.length);
      for (let i = 0; i < value.length; i++) {
        setListElement(list, field.type.elementType, i, value[i]);
      }
      return;
    }

    case "group":
    case "struct": {
      if (value instanceof capnp.Struct) {
        struct[field.name] = value;
      } else {
        fillStruct(struct[`_init${capitalizedFieldName(field)}`](), value);
      }
      return;
    }

    case "int64":
    case "uint64": {
      struct[field.name] = typeof value === "bigint" ? value : BigInt(value);
      return;
    }

    default:
      struct[field.name] = value;
  }
}

function interfaceValueForField(field, value) {
  if (value instanceof WrappedClient) return value;
  if (isGeneratedClient(value)) return value;

  const InterfaceClass = interfaceByTypeId.get(field.type.typeId);
  if (!InterfaceClass) return value;

  if (typeof value?.call === "function") {
    return new InterfaceClass.Client(value);
  }

  return new Capability(value, InterfaceClass);
}

function setAnyPointer(struct, field, value) {
  const client = rawClientValue(value);
  if (value instanceof capnp.Pointer) {
    const iface = capnp.Interface.fromPointer(value);
    const pointerClient = iface && iface.getClient();
    if (pointerClient) {
      capnp.utils.setInterfacePointer(
        struct.segment.message.addCap(pointerClient),
        capnp.utils.getPointer(field.offset, struct),
      );
    } else {
      struct[field.name] = value;
    }
  } else if (client) {
    capnp.utils.setInterfacePointer(
      struct.segment.message.addCap(client),
      capnp.utils.getPointer(field.offset, struct),
    );
  } else if (field.name === "sessionParams" &&
      (Buffer.isBuffer(value) || value instanceof Uint8Array)) {
    copySerializedRootPointer(struct, field, value);
  } else if (field.name === "value" &&
      (Buffer.isBuffer(value) || value instanceof Uint8Array)) {
    copySerializedRootPointer(struct, field, value);
  } else if (field.name === "appRef" &&
      (Buffer.isBuffer(value) || value instanceof Uint8Array)) {
    copySerializedRootPointer(struct, field, value);
  } else if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const data = capnp.utils.initData(field.offset, value.byteLength, struct);
    data.copyBuffer(value);
  } else if (typeof value === "string") {
    capnp.utils.setText(field.offset, value, struct);
  } else if (field.name === "sealFor") {
    const owner = capnp.utils.initStructAt(field.offset, Supervisor.ApiTokenOwner, struct);
    fillStruct(owner, value);
  } else {
    throw new Error(`Cannot encode AnyPointer field: ${field.name}`);
  }
}

function rawClientValue(value) {
  if (value instanceof WrappedClient) return value.client;
  if (isGeneratedClient(value)) return value.client;
  if (typeof value?.call === "function") return value;
  return null;
}

function copySerializedRootPointer(struct, field, value) {
  const source = new capnp.Pointer(new capnp.Message(Buffer.from(value), false).getSegment(0), 0);
  capnp.utils.copyFrom(source, capnp.utils.getPointer(field.offset, struct));
}

function setListElement(list, elementType, index, value) {
  switch (elementType?.kind) {
    case "struct":
      fillStruct(list.get(index), value);
      break;
    case "enum":
      list.set(index, enumValue(elementType.displayName, value));
      break;
    case "int64":
    case "uint64":
      list.set(index, typeof value === "bigint" ? value : BigInt(value));
      break;
    default:
      list.set(index, value);
      break;
  }
}

function fieldToPlain(struct, field, alreadyCheckedUnion) {
  try {
    if (!alreadyCheckedUnion && isInactiveUnionField(struct, field)) return undefined;

    if (field.type?.kind === "void") {
      return null;
    }

    const value = struct[field.name];
    return valueToPlain(value, field.type, field);
  } catch (err) {
    if (isInactiveUnionAccess(err) ||
        field.discriminantValue !== undefined && isOutOfBoundsDataAccess(err)) {
      return undefined;
    }

    throw err;
  }
}

function structToPlain(struct) {
  return structConverter(struct.constructor)(struct);
}

function structConverter(StructClass) {
  let converter = structConverterCache.get(StructClass);
  if (!converter) {
    converter = makeStructConverter(StructClass._capnp.fields || []);
    structConverterCache.set(StructClass, converter);
  }

  return converter;
}

function makeStructConverter(fields) {
  const entries = sortedFields(fields).map((field) => ({
    field,
    name: field.name,
    hasMethodName: `_has${capitalizedFieldName(field)}`,
    isPointer: isPointerField(field),
    discriminantValue: field.discriminantValue,
    isVoid: field.type?.kind === "void",
    convert: valueConverterFor(field.type, field),
  }));
  const hasUnionFields = entries.some((entry) => entry.discriminantValue !== undefined);
  return compileStructConverter(entries, hasUnionFields);
}

function compileStructConverter(entries, hasUnionFields) {
  const lines = [
    "\"use strict\";",
    "return function convertStruct(struct) {",
    "const out = {};",
  ];

  if (hasUnionFields) {
    lines.push(
      "const activeUnion = typeof struct.which === \"function\" ? struct.which() : undefined;",
      "const checkedUnion = activeUnion !== undefined;",
    );
  } else {
    lines.push("const checkedUnion = true;");
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    lines.push("{");
    if (hasUnionFields && entry.discriminantValue !== undefined) {
      lines.push("if (!checkedUnion) {");
      emitFallbackEntry(lines, i, entry);
      lines.push(`} else if (activeUnion === ${JSON.stringify(entry.discriminantValue)}) {`);
      emitFastEntry(lines, i, entry);
      lines.push("}");
    } else {
      emitFastEntry(lines, i, entry);
    }

    lines.push("}");
  }

  lines.push(
    "return out;",
    "};",
  );

  return Function("helpers", "entries", lines.join("\n"))({
    fieldEntryToPlain,
    hasPointerField,
    isNullPointerField,
  }, entries);
}

function emitFastEntry(lines, index, entry) {
  if (entry.isPointer) {
    lines.push(
      `const hasMethod = struct[${JSON.stringify(entry.hasMethodName)}];`,
      "if (typeof hasMethod === \"function\" ? " +
        "helpers.hasPointerField(struct, hasMethod) : " +
        `!helpers.isNullPointerField(struct, entries[${index}].field)) {`,
    );
  }

  lines.push(entry.isVoid ?
    "const value = null;" :
    `const value = entries[${index}].convert(struct[${JSON.stringify(entry.name)}]);`);
  lines.push(`if (value !== undefined) out[${JSON.stringify(entry.name)}] = value;`);

  if (entry.isPointer) {
    lines.push("}");
  }
}

function emitFallbackEntry(lines, index, entry) {
  lines.push(
    `const value = helpers.fieldEntryToPlain(struct, entries[${index}], false);`,
    `if (value !== undefined) out[${JSON.stringify(entry.name)}] = value;`,
  );
}

function fieldEntryToPlain(struct, entry, alreadyCheckedUnion) {
  try {
    if (!alreadyCheckedUnion && isInactiveUnionField(struct, entry.field)) return undefined;

    if (entry.isVoid) return null;

    const value = struct[entry.name];
    return entry.convert(value);
  } catch (err) {
    if (isInactiveUnionAccess(err) ||
        entry.discriminantValue !== undefined && isOutOfBoundsDataAccess(err)) {
      return undefined;
    }

    throw err;
  }
}

function isInactiveUnionField(struct, field) {
  return field.discriminantValue !== undefined &&
      typeof struct.which === "function" &&
      struct.which() !== field.discriminantValue;
}

function hasPointerField(struct, hasMethod) {
  try {
    return hasMethod.call(struct);
  } catch (err) {
    if (isOutOfBoundsPointerAccess(err)) return false;
    throw err;
  }
}

function isNullPointerField(struct, field) {
  if (!isPointerField(field)) return false;

  try {
    return capnp.utils.isNull(capnp.utils.getPointer(field.offset, struct));
  } catch (err) {
    if (isOutOfBoundsPointerAccess(err)) return true;
    throw err;
  }
}

function isPointerField(field) {
  switch (field.type?.kind) {
    case "anyPointer":
    case "data":
    case "interface":
    case "list":
    case "struct":
    case "text":
      return true;
    default:
      return false;
  }
}

function isOutOfBoundsPointerAccess(err) {
  const message = String(err?.message || "");
  return message.includes("Attempted to access out-of-bounds struct pointer");
}

function isOutOfBoundsDataAccess(err) {
  const message = String(err?.message || "");
  return message.includes("Attempted to access out-of-bounds struct data");
}

function valueToPlain(value, type, field) {
  if (field) {
    let converter = fieldValueConverterCache.get(field);
    if (!converter) {
      converter = valueConverterFor(type, field);
      fieldValueConverterCache.set(field, converter);
    }

    return converter(value);
  }

  return valueConverterFor(type, field)(value);
}

function valueConverterFor(type, field) {
  switch (type?.kind) {
    case "anyPointer":
      return (value) => value === undefined || value === null ? value : anyPointerToPlain(value, field);
    case "data":
      return (value) => value === undefined || value === null ? value :
        Buffer.from(value.toUint8Array());
    case "enum":
      return (value) => value === undefined || value === null ? value :
        enumName(type.displayName, value);
    case "interface": {
      const InterfaceClass = interfaceByTypeId.get(type.typeId);
      return (value) => value === undefined || value === null ? value :
        InterfaceClass ? wrapClient(InterfaceClass, value) : value;
    }
    case "list": {
      const convertElement = valueConverterFor(type.elementType);
      return (value) => {
        if (value === undefined || value === null) return value;

        const out = new Array(value.length);
        for (let i = 0; i < value.length; i++) {
          out[i] = convertElement(value.get(i));
        }

        return out;
      };
    }
    case "group":
    case "struct":
      return (value) => value === undefined || value === null ? value : structToPlain(value);
    case "int64":
    case "uint64":
      return (value) => value === undefined || value === null ? value : int64ToPlain(value);
    default:
      return (value) => value;
  }
}

function int64ToPlain(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value.toString();
}

function isInactiveUnionAccess(err) {
  const message = String(err?.message || "");
  return message.includes("Attempted to access non-active union member") ||
    message.includes("union field") && message.includes("not currently set");
}

function anyPointerToPlain(value, field) {
  const iface = capnp.Interface.fromPointer(value);
  if (iface) {
    const client = iface.getClient();
    if (client) return wrapClient(Supervisor.SystemPersistent, client);
  }

  if (field?.name === "sealFor") {
    return structToPlain(new Supervisor.ApiTokenOwner(
      value.segment,
      value.byteOffset,
      value._capnp.depthLimit,
    ));
  }

  if (field?.name === "sturdyRef") {
    return Buffer.from(capnp.Data.fromPointer(value).toUint8Array());
  }

  if (field?.name === "objectId") {
    return pointerToBuffer(value);
  }

  return pointerToBuffer(value);
}

function pointerToBuffer(value) {
  const message = new capnp.Message();
  message.setRoot(value);
  return Buffer.from(message.toArrayBuffer());
}

function sortedFields(fields) {
  if (!fields || fields.length <= 1) return fields || [];

  let sorted = sortedFieldsCache.get(fields);
  if (!sorted) {
    sorted = [...fields].sort((a, b) => a.codeOrder - b.codeOrder);
    sortedFieldsCache.set(fields, sorted);
  }

  return sorted;
}

function capitalizedFieldName(field) {
  let name = capitalizedFieldNameCache.get(field);
  if (!name) {
    name = capitalize(field.name);
    capitalizedFieldNameCache.set(field, name);
  }

  return name;
}

function enumValue(displayName, value) {
  if (typeof value !== "string") return value;
  const enumObject = enumByDisplayName.get(displayName);
  if (!enumObject) return value;

  const upper = value.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
  return enumObject[upper] ?? enumObject[value.toUpperCase()] ?? value;
}

function enumName(displayName, value) {
  const enumObject = enumByDisplayName.get(displayName);
  if (!enumObject) return value;

  let names = enumNameCache.get(enumObject);
  if (!names) {
    names = new Map();
    for (const [name, enumValue_] of Object.entries(enumObject)) {
      names.set(enumValue_, lowerCamel(name));
    }
    enumNameCache.set(enumObject, names);
  }

  return names.get(value) ?? value;
}

function isEnumObject(value) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).length > 0 &&
    Object.values(value).every((entry) => typeof entry === "number");
}

function enumDisplayNameAliases(exportName) {
  const parts = exportName.split("_");
  if (parts.length < 2) return [];

  const last = parts[parts.length - 1];
  if (last === "Which") return [];
  return [last];
}

function capitalize(name) {
  return name[0].toUpperCase() + name.slice(1);
}

function lowerCamel(name) {
  return name.toLowerCase().replace(/_([a-z])/g, (_match, c) => c.toUpperCase());
}

function chacha20(message, nonce, key) {
  if (nonce.length !== 8) throw new Error("chacha20 nonce must be 8 bytes");
  if (key.length !== 32) throw new Error("chacha20 key must be 32 bytes");

  const input = Buffer.from(message);
  const output = Buffer.alloc(input.length);
  const state = new Uint32Array(16);
  const block = Buffer.alloc(64);
  let counterLow = 0;
  let counterHigh = 0;

  state[0] = 0x61707865;
  state[1] = 0x3320646e;
  state[2] = 0x79622d32;
  state[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) state[4 + i] = key.readUInt32LE(i * 4);
  state[14] = nonce.readUInt32LE(0);
  state[15] = nonce.readUInt32LE(4);

  for (let offset = 0; offset < input.length; offset += 64) {
    state[12] = counterLow;
    state[13] = counterHigh;
    chachaBlock(state, block);
    counterLow = (counterLow + 1) >>> 0;
    if (counterLow === 0) counterHigh = (counterHigh + 1) >>> 0;

    const n = Math.min(64, input.length - offset);
    for (let i = 0; i < n; i++) output[offset + i] = input[offset + i] ^ block[i];
  }

  return output;
}

function chachaBlock(state, out) {
  const x = new Uint32Array(state);
  for (let i = 0; i < 10; i++) {
    quarterRound(x, 0, 4, 8, 12);
    quarterRound(x, 1, 5, 9, 13);
    quarterRound(x, 2, 6, 10, 14);
    quarterRound(x, 3, 7, 11, 15);
    quarterRound(x, 0, 5, 10, 15);
    quarterRound(x, 1, 6, 11, 12);
    quarterRound(x, 2, 7, 8, 13);
    quarterRound(x, 3, 4, 9, 14);
  }

  for (let i = 0; i < 16; i++) {
    out.writeUInt32LE((x[i] + state[i]) >>> 0, i * 4);
  }
}

function quarterRound(x, a, b, c, d) {
  x[a] = (x[a] + x[b]) >>> 0; x[d] = rotl(x[d] ^ x[a], 16);
  x[c] = (x[c] + x[d]) >>> 0; x[b] = rotl(x[b] ^ x[c], 12);
  x[a] = (x[a] + x[b]) >>> 0; x[d] = rotl(x[d] ^ x[a], 8);
  x[c] = (x[c] + x[d]) >>> 0; x[b] = rotl(x[b] ^ x[c], 7);
}

function rotl(value, bits) {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

export default {
  Capability,
  chacha20,
  connect,
  importSystem,
  matchPowerboxQuery,
  parse,
  proxyClient,
  serialize,
  serializePacked,
};
