import { e as erase, L as ListElementSize } from './capnp-es.Da9bkTPj.mjs';
import { J as initList } from './capnp-es.iydqJhtG.mjs';

function applyInit(target, value) {
  if (value === void 0) {
    return;
  }
  if (typeof value === "function") {
    value(target);
    return;
  }
  const structClass = target.constructor;
  if (typeof structClass._applyInit === "function") {
    structClass._applyInit(target, value);
    return;
  }
  throw new TypeError(
    `${target.constructor.name} does not have a generated _applyInit() method.`
  );
}
function dataBytes(value) {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (isIterable(value)) {
    return Uint8Array.from(value);
  }
  throw new TypeError(
    "Data fields require Data, ArrayBuffer, ArrayBufferView, or Iterable<number> values."
  );
}
function initDataValue(data, length) {
  erase(data);
  initList(ListElementSize.BYTE, length, data);
  return data;
}
function initListValue(list, length) {
  const listClass = list.constructor;
  erase(list);
  initList(
    listClass._capnp.size,
    length,
    list,
    listClass._capnp.compositeSize
  );
  return list;
}
function isIterable(value) {
  return value !== null && typeof value === "object" && typeof value[Symbol.iterator] === "function";
}

export { applyInit as a, initListValue as b, dataBytes as d, initDataValue as i };
