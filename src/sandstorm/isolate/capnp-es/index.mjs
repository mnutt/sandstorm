export { a as applyInit, d as dataBytes, i as initDataValue, b as initListValue } from './shared/capnp-es.jIzw5uss.mjs';
import { S as Struct, O as ObjectSize, an as PointerAllocationResult, ao as add, a as adopt, c as copyFrom, ap as copyFromInterface, aq as copyFromList, ar as copyFromStruct, d as disown, as as dump, e as erase, at as erasePointer, au as followFar, z as followFars, av as getCapabilityId, t as getContent, aw as getFarSegmentId, H as getInterfacePointer, ax as getListByteLength, o as getListElementByteLength, ay as getListElementSize, az as getListLength, aA as getOffsetWords, aB as getPointerType, aC as getStructDataWords, aD as getStructPointerLength, G as getStructSize, x as getTargetCompositeListSize, aE as getTargetCompositeListTag, B as getTargetListElementSize, g as getTargetListLength, A as getTargetPointerType, w as getTargetStructSize, q as initPointer, aF as isDoubleFar, i as isNull, aG as relocateTo, aH as setFarPointer, af as setInterfacePointer, s as setListPointer, n as setStructPointer, aI as trackPointerAllocation, v as validate, L as ListElementSize, P as Pointer } from './shared/capnp-es.Da9bkTPj.mjs';
export { aJ as Orphan, r as PointerType } from './shared/capnp-es.Da9bkTPj.mjs';
export { M as Message, r as readRawPointer } from './shared/capnp-es.Da2a44Ii.mjs';
export { C as CompositeList, g as getBitMask, c as getFloat32Mask, d as getFloat64Mask, e as getInt16Mask, f as getInt32Mask, h as getInt64Mask, i as getInt8Mask, b as getUint16Mask, j as getUint32Mask, k as getUint64Mask, a as getUint8Mask } from './shared/capnp-es.CKgVaTmi.mjs';
import { Q as checkDataBounds, R as checkPointerBounds, k as getAs, d as getBit, H as getData, S as getDataSection, B as getFloat32, F as getFloat64, v as getInt16, x as getInt32, z as getInt64, r as getInt8, O as getInterfaceClientOrNull, T as getInterfaceClientOrNullAt, l as getList, g as getPointer, U as getPointerAs, V as getPointerSection, W as getSize, f as getStruct, p as getText, a as getUint16, b as getUint32, h as getUint64, n as getUint8, I as initData, m as initList, M as initStruct, i as initStructAt, K as resize, e as setBit, C as setFloat32, G as setFloat64, w as setInt16, y as setInt32, A as setInt64, u as setInt8, q as setText, s as setUint16, c as setUint32, j as setUint64, o as setUint8, t as testWhich, L as List, D as Data, X as Text } from './shared/capnp-es.iydqJhtG.mjs';
export { P as ErrorClient, Y as clientOrNull } from './shared/capnp-es.iydqJhtG.mjs';
import { I as Interface } from './shared/capnp-es.2NJr_hdR.mjs';
export { C as CapnpRpcError, D as Deferred, P as Pipeline, C as RPCError, R as Registry, f as codeToExceptionType, c as copyCall, e as exceptionTypeToCode, d as isDataCall, i as isFuncCall, p as placeParams, a as toException } from './shared/capnp-es.2NJr_hdR.mjs';
export { C as Conn, D as DeferredTransport, a as answerPipelineClient, c as clientFromResolution, i as isSameClient } from './shared/capnp-es.VoaMMsf2.mjs';
export { S as Server } from './shared/capnp-es.BLGTYa4t.mjs';
import './capnp/rpc.mjs';

class Void extends Struct {
  static _capnp = {
    displayName: "Void",
    id: "0",
    typeId: 0n,
    typeIdHex: "0",
    size: new ObjectSize(0, 0),
    fields: []
  };
}

const utils = {
  __proto__: null,
  PointerAllocationResult: PointerAllocationResult,
  add: add,
  adopt: adopt,
  checkDataBounds: checkDataBounds,
  checkPointerBounds: checkPointerBounds,
  copyFrom: copyFrom,
  copyFromInterface: copyFromInterface,
  copyFromList: copyFromList,
  copyFromStruct: copyFromStruct,
  disown: disown,
  dump: dump,
  erase: erase,
  erasePointer: erasePointer,
  followFar: followFar,
  followFars: followFars,
  getAs: getAs,
  getBit: getBit,
  getCapabilityId: getCapabilityId,
  getContent: getContent,
  getData: getData,
  getDataSection: getDataSection,
  getFarSegmentId: getFarSegmentId,
  getFloat32: getFloat32,
  getFloat64: getFloat64,
  getInt16: getInt16,
  getInt32: getInt32,
  getInt64: getInt64,
  getInt8: getInt8,
  getInterfaceClientOrNull: getInterfaceClientOrNull,
  getInterfaceClientOrNullAt: getInterfaceClientOrNullAt,
  getInterfacePointer: getInterfacePointer,
  getList: getList,
  getListByteLength: getListByteLength,
  getListElementByteLength: getListElementByteLength,
  getListElementSize: getListElementSize,
  getListLength: getListLength,
  getOffsetWords: getOffsetWords,
  getPointer: getPointer,
  getPointerAs: getPointerAs,
  getPointerSection: getPointerSection,
  getPointerType: getPointerType,
  getSize: getSize,
  getStruct: getStruct,
  getStructDataWords: getStructDataWords,
  getStructPointerLength: getStructPointerLength,
  getStructSize: getStructSize,
  getTargetCompositeListSize: getTargetCompositeListSize,
  getTargetCompositeListTag: getTargetCompositeListTag,
  getTargetListElementSize: getTargetListElementSize,
  getTargetListLength: getTargetListLength,
  getTargetPointerType: getTargetPointerType,
  getTargetStructSize: getTargetStructSize,
  getText: getText,
  getUint16: getUint16,
  getUint32: getUint32,
  getUint64: getUint64,
  getUint8: getUint8,
  initData: initData,
  initList: initList,
  initPointer: initPointer,
  initStruct: initStruct,
  initStructAt: initStructAt,
  isDoubleFar: isDoubleFar,
  isNull: isNull,
  relocateTo: relocateTo,
  resize: resize,
  setBit: setBit,
  setFarPointer: setFarPointer,
  setFloat32: setFloat32,
  setFloat64: setFloat64,
  setInt16: setInt16,
  setInt32: setInt32,
  setInt64: setInt64,
  setInt8: setInt8,
  setInterfacePointer: setInterfacePointer,
  setListPointer: setListPointer,
  setStructPointer: setStructPointer,
  setText: setText,
  setUint16: setUint16,
  setUint32: setUint32,
  setUint64: setUint64,
  setUint8: setUint8,
  testWhich: testWhich,
  trackPointerAllocation: trackPointerAllocation,
  validate: validate
};

function PointerList(PointerClass) {
  return class extends List {
    static _capnp = {
      displayName: `List<${PointerClass._capnp.displayName}>`,
      size: ListElementSize.POINTER
    };
    get(index) {
      const c = getContent(this);
      return new PointerClass(
        c.segment,
        c.byteOffset + index * 8,
        this._capnp.depthLimit - 1
      );
    }
    set(index, value) {
      copyFrom(value, this.get(index));
    }
    [Symbol.toStringTag]() {
      return `Pointer_${super.toString()},cls:${PointerClass.toString()}`;
    }
  };
}

const AnyPointerList = PointerList(Pointer);

class BoolList extends List {
  static _capnp = {
    displayName: "List<boolean>",
    size: ListElementSize.BIT
  };
  get(index) {
    const bitMask = 1 << index % 8;
    const byteOffset = index >>> 3;
    const c = getContent(this);
    const v = c.segment.getUint8(c.byteOffset + byteOffset);
    return (v & bitMask) !== 0;
  }
  set(index, value) {
    const bitMask = 1 << index % 8;
    const c = getContent(this);
    const byteOffset = c.byteOffset + (index >>> 3);
    const v = c.segment.getUint8(byteOffset);
    c.segment.setUint8(byteOffset, value ? v | bitMask : v & ~bitMask);
  }
  [Symbol.toStringTag]() {
    return `Bool_${super.toString()}`;
  }
}

const DataList = PointerList(Data);

class Float32List extends List {
  static _capnp = {
    displayName: "List<Float32>",
    size: ListElementSize.BYTE_4
  };
  get(index) {
    const c = getContent(this);
    return c.segment.getFloat32(c.byteOffset + index * 4);
  }
  set(index, value) {
    const c = getContent(this);
    c.segment.setFloat32(c.byteOffset + index * 4, value);
  }
  [Symbol.toStringTag]() {
    return `Float32_${super.toString()}`;
  }
}

class Float64List extends List {
  static _capnp = {
    displayName: "List<Float64>",
    size: ListElementSize.BYTE_8
  };
  get(index) {
    const c = getContent(this);
    return c.segment.getFloat64(c.byteOffset + index * 8);
  }
  set(index, value) {
    const c = getContent(this);
    c.segment.setFloat64(c.byteOffset + index * 8, value);
  }
  [Symbol.toStringTag]() {
    return `Float64_${super.toString()}`;
  }
}

class Int8List extends List {
  static _capnp = {
    displayName: "List<Int8>",
    size: ListElementSize.BYTE
  };
  get(index) {
    const c = getContent(this);
    return c.segment.getInt8(c.byteOffset + index);
  }
  set(index, value) {
    const c = getContent(this);
    c.segment.setInt8(c.byteOffset + index, value);
  }
  [Symbol.toStringTag]() {
    return `Int8_${super.toString()}`;
  }
}

class Int16List extends List {
  static _capnp = {
    displayName: "List<Int16>",
    size: ListElementSize.BYTE_2
  };
  get(index) {
    const c = getContent(this);
    return c.segment.getInt16(c.byteOffset + index * 2);
  }
  set(index, value) {
    const c = getContent(this);
    c.segment.setInt16(c.byteOffset + index * 2, value);
  }
  [Symbol.toStringTag]() {
    return `Int16_${super.toString()}`;
  }
}

class Int32List extends List {
  static _capnp = {
    displayName: "List<Int32>",
    size: ListElementSize.BYTE_4
  };
  get(index) {
    const c = getContent(this);
    return c.segment.getInt32(c.byteOffset + index * 4);
  }
  set(index, value) {
    const c = getContent(this);
    c.segment.setInt32(c.byteOffset + index * 4, value);
  }
  [Symbol.toStringTag]() {
    return `Int32_${super.toString()}`;
  }
}

class Int64List extends List {
  static _capnp = {
    displayName: "List<Int64>",
    size: ListElementSize.BYTE_8
  };
  get(index) {
    const c = getContent(this);
    return c.segment.getInt64(c.byteOffset + index * 8);
  }
  set(index, value) {
    const c = getContent(this);
    c.segment.setInt64(c.byteOffset + index * 8, value);
  }
  [Symbol.toStringTag]() {
    return `Int64_${super.toString()}`;
  }
}

const InterfaceList = PointerList(Interface);

class TextList extends List {
  static _capnp = {
    displayName: "List<Text>",
    size: ListElementSize.POINTER
  };
  get(index) {
    const c = getContent(this);
    c.byteOffset += index * 8;
    return Text.fromPointer(c).get(0);
  }
  set(index, value) {
    const c = getContent(this);
    c.byteOffset += index * 8;
    Text.fromPointer(c).set(0, value);
  }
  [Symbol.toStringTag]() {
    return `Text_${super.toString()}`;
  }
}

class Uint8List extends List {
  static _capnp = {
    displayName: "List<Uint8>",
    size: ListElementSize.BYTE
  };
  get(index) {
    const c = getContent(this);
    return c.segment.getUint8(c.byteOffset + index);
  }
  set(index, value) {
    const c = getContent(this);
    c.segment.setUint8(c.byteOffset + index, value);
  }
  [Symbol.toStringTag]() {
    return `Uint8_${super.toString()}`;
  }
}

class Uint16List extends List {
  static _capnp = {
    displayName: "List<Uint16>",
    size: ListElementSize.BYTE_2
  };
  get(index) {
    const c = getContent(this);
    return c.segment.getUint16(c.byteOffset + index * 2);
  }
  set(index, value) {
    const c = getContent(this);
    c.segment.setUint16(c.byteOffset + index * 2, value);
  }
  [Symbol.toStringTag]() {
    return `Uint16_${super.toString()}`;
  }
}

class Uint32List extends List {
  static _capnp = {
    displayName: "List<Uint32>",
    size: ListElementSize.BYTE_4
  };
  get(index) {
    const c = getContent(this);
    return c.segment.getUint32(c.byteOffset + index * 4);
  }
  set(index, value) {
    const c = getContent(this);
    c.segment.setUint32(c.byteOffset + index * 4, value);
  }
  [Symbol.toStringTag]() {
    return `Uint32_${super.toString()}`;
  }
}

class Uint64List extends List {
  static _capnp = {
    displayName: "List<Uint64>",
    size: ListElementSize.BYTE_8
  };
  get(index) {
    const c = getContent(this);
    return c.segment.getUint64(c.byteOffset + index * 8);
  }
  set(index, value) {
    const c = getContent(this);
    c.segment.setUint64(c.byteOffset + index * 8, value);
  }
  [Symbol.toStringTag]() {
    return `Uint64_${super.toString()}`;
  }
}

const VoidList = PointerList(Void);

class MalformedSturdyRefError extends Error {
  name = "MalformedSturdyRefError";
}
class UnknownSturdyRefError extends Error {
  name = "UnknownSturdyRefError";
}
class UnsupportedRealmTransformError extends Error {
  name = "UnsupportedRealmTransformError";
}
class JsonSturdyRefCodec {
  constructor(validate) {
    this.validate = validate;
  }
  #encoder = new TextEncoder();
  #decoder = new TextDecoder();
  encode(ref) {
    return this.#encoder.encode(JSON.stringify(ref));
  }
  decode(payload) {
    let raw;
    try {
      raw = JSON.parse(this.#decoder.decode(payload));
    } catch {
      throw new MalformedSturdyRefError("invalid sturdyRef payload");
    }
    if (this.validate && !this.validate(raw)) {
      throw new MalformedSturdyRefError("sturdyRef payload failed validation");
    }
    return raw;
  }
}
class RealmTransformRegistry {
  #transforms = /* @__PURE__ */ new Map();
  register(fromRealm, toRealm, transform) {
    this.#transforms.set(`${fromRealm}->${toRealm}`, transform);
  }
  transform(ref, fromRealm, toRealm) {
    if (fromRealm === toRealm) {
      return ref;
    }
    const fn = this.#transforms.get(`${fromRealm}->${toRealm}`);
    if (!fn) {
      throw new UnsupportedRealmTransformError(
        `unsupported sturdyRef realm transform: ${fromRealm} -> ${toRealm}`
      );
    }
    return fn(ref);
  }
}
class MapRestorerLookup {
  constructor(entries, keyOf = (ref) => JSON.stringify(ref)) {
    this.keyOf = keyOf;
    if (entries) {
      for (const [ref, capability] of entries) {
        this.#entries.set(this.keyOf(ref), capability);
      }
    }
  }
  #entries = /* @__PURE__ */ new Map();
  set(ref, capability) {
    this.#entries.set(this.keyOf(ref), capability);
  }
  restore(ref) {
    const key = this.keyOf(ref);
    if (!this.#entries.has(key)) {
      throw new UnknownSturdyRefError("unknown sturdyRef");
    }
    return this.#entries.get(key);
  }
}

export { AnyPointerList, BoolList, Data, DataList, Float32List, Float64List, Int16List, Int32List, Int64List, Int8List, Interface, InterfaceList, JsonSturdyRefCodec, List, ListElementSize, MalformedSturdyRefError, MapRestorerLookup, ObjectSize, Pointer, PointerList, RealmTransformRegistry, Struct, Text, TextList, Uint16List, Uint32List, Uint64List, Uint8List, UnknownSturdyRefError, UnsupportedRealmTransformError, Void, VoidList, utils };
