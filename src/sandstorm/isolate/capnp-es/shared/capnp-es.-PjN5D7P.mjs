import { f as format, P as PTR_INVALID_LIST_SIZE, L as ListElementSize, s as setListPointer, b as PTR_COMPOSITE_SIZE_UNDEFINED, e as padToWord, g as getByteLength, h as setStructPointer, j as getListElementByteLength, k as initPointer, l as Pointer, m as getTargetListLength, n as LIST_NO_SEARCH, o as LIST_NO_MUTABLE, v as validate, q as PointerType, r as getContent, i as isNull, t as erase, u as RPC_NULL_CLIENT, w as getTargetStructSize, x as getTargetCompositeListSize, y as getWordLength, z as followFars, A as getTargetPointerType, B as getTargetListElementSize, C as PTR_STRUCT_DATA_OUT_OF_BOUNDS, D as PTR_STRUCT_POINTER_OUT_OF_BOUNDS, p as padToWord$1, E as PTR_INIT_COMPOSITE_STRUCT, F as getDataWordLength, G as getStructSize, H as getInterfacePointer, c as copyFrom, N as NATIVE_LITTLE_ENDIAN, I as PTR_INVALID_UNION_ACCESS } from './capnp-es.BylpbGNO.mjs';

class List extends Pointer {
  static _capnp = {
    displayName: "List<Generic>",
    size: ListElementSize.VOID
  };
  constructor(segment, byteOffset, depthLimit) {
    super(segment, byteOffset, depthLimit);
    return new Proxy(this, List.#proxyHandler);
  }
  static #proxyHandler = {
    get(target, prop, receiver) {
      const val = Reflect.get(target, prop, receiver);
      if (val !== void 0) {
        return val;
      }
      if (typeof prop === "string") {
        return target.get(+prop);
      }
    }
  };
  get length() {
    return getTargetListLength(this);
  }
  toArray() {
    const { length } = this;
    const res = Array.from({ length });
    for (let i = 0; i < length; i++) {
      res[i] = this.at(i);
    }
    return res;
  }
  get(_index) {
    throw new TypeError("Cannot get from a generic list.");
  }
  set(_index, _value) {
    throw new TypeError("Cannot set on a generic list.");
  }
  at(index) {
    return this.get(index < 0 ? this.length + index : index);
  }
  concat(other) {
    const { length } = this;
    const otherLength = other.length;
    const res = Array.from({ length: length + otherLength });
    for (let i = 0; i < length; i++) res[i] = this.at(i);
    for (let i = 0; i < otherLength; i++) res[i + length] = other.at(i);
    return res;
  }
  some(cb, _this) {
    for (let i = 0; i < this.length; i++) {
      if (cb.call(_this, this.at(i), i, this)) {
        return true;
      }
    }
    return false;
  }
  filter(cb, _this) {
    const res = [];
    for (let i = 0; i < this.length; i++) {
      const value = this.at(i);
      if (cb.call(_this, value, i, this)) {
        res.push(value);
      }
    }
    return res;
  }
  find(cb, _this) {
    for (let i = 0; i < this.length; i++) {
      const value = this.at(i);
      if (cb.call(_this, value, i, this)) {
        return value;
      }
    }
    return void 0;
  }
  findIndex(cb, _this) {
    for (let i = 0; i < this.length; i++) {
      const value = this.at(i);
      if (cb.call(_this, value, i, this)) {
        return i;
      }
    }
    return -1;
  }
  forEach(cb, _this) {
    for (let i = 0; i < this.length; i++) {
      cb.call(_this, this.at(i), i, this);
    }
  }
  map(cb, _this) {
    const { length } = this;
    const res = Array.from({ length });
    for (let i = 0; i < length; i++) {
      res[i] = cb.call(_this, this.at(i), i, this);
    }
    return res;
  }
  flatMap(cb, _this) {
    const res = [];
    for (let i = 0; i < this.length; i++) {
      const r = cb.call(_this, this.at(i), i, this);
      res.push(...Array.isArray(r) ? r : [r]);
    }
    return res;
  }
  every(cb, _this) {
    for (let i = 0; i < this.length; i++) {
      if (!cb.call(_this, this.at(i), i, this)) {
        return false;
      }
    }
    return true;
  }
  reduce(cb, initialValue) {
    let i = 0;
    let res;
    if (initialValue === void 0) {
      res = this.at(0);
      i++;
    } else {
      res = initialValue;
    }
    for (; i < this.length; i++) {
      res = cb(res, this.at(i), i, this);
    }
    return res;
  }
  reduceRight(cb, initialValue) {
    let i = this.length - 1;
    let res;
    if (initialValue === void 0) {
      res = this.at(i);
      i--;
    } else {
      res = initialValue;
    }
    for (; i >= 0; i--) {
      res = cb(res, this.at(i), i, this);
    }
    return res;
  }
  slice(start = 0, end) {
    const length = end ? Math.min(this.length, end) : this.length;
    const res = Array.from({ length: length - start });
    for (let i = start; i < length; i++) {
      res[i] = this.at(i);
    }
    return res;
  }
  join(separator) {
    return this.toArray().join(separator);
  }
  toReversed() {
    return this.toArray().reverse();
  }
  toSorted(compareFn) {
    return this.toArray().sort(compareFn);
  }
  toSpliced(start, deleteCount, ...items) {
    return this.toArray().splice(start, deleteCount, ...items);
  }
  fill(value, start, end) {
    const { length } = this;
    const s = Math.max(start ?? 0, 0);
    const e = Math.min(end ?? length, length);
    for (let i = s; i < e; i++) {
      this.set(i, value);
    }
    return this;
  }
  copyWithin(target, start, end) {
    const { length } = this;
    const e = end ?? length;
    const s = start < 0 ? Math.max(length + start, 0) : start;
    const t = target < 0 ? Math.max(length + target, 0) : target;
    const len = Math.min(e - s, length - t);
    for (let i = 0; i < len; i++) {
      this.set(t + i, this.at(s + i));
    }
    return this;
  }
  keys() {
    return Array.from({ length: this.length }, (_, i) => i)[Symbol.iterator]();
  }
  values() {
    return this.toArray().values();
  }
  entries() {
    return this.toArray().entries();
  }
  flat(depth) {
    return this.toArray().flat(depth);
  }
  with(index, value) {
    return this.toArray().with(index, value);
  }
  includes(_searchElement, _fromIndex) {
    throw new Error(LIST_NO_SEARCH);
  }
  findLast(_cb, _thisArg) {
    throw new Error(LIST_NO_SEARCH);
  }
  findLastIndex(_cb, _t) {
    throw new Error(LIST_NO_SEARCH);
  }
  indexOf(_searchElement, _fromIndex) {
    throw new Error(LIST_NO_SEARCH);
  }
  lastIndexOf(_searchElement, _fromIndex) {
    throw new Error(LIST_NO_SEARCH);
  }
  pop() {
    throw new Error(LIST_NO_MUTABLE);
  }
  push(..._items) {
    throw new Error(LIST_NO_MUTABLE);
  }
  reverse() {
    throw new Error(LIST_NO_MUTABLE);
  }
  shift() {
    throw new Error(LIST_NO_MUTABLE);
  }
  unshift(..._items) {
    throw new Error(LIST_NO_MUTABLE);
  }
  splice(_start, _deleteCount, ..._rest) {
    throw new Error(LIST_NO_MUTABLE);
  }
  sort(_fn) {
    throw new Error(LIST_NO_MUTABLE);
  }
  get [Symbol.unscopables]() {
    return Array.prototype[Symbol.unscopables];
  }
  [Symbol.iterator]() {
    return this.values();
  }
  toJSON() {
    return this.toArray();
  }
  toString() {
    return this.join(",");
  }
  toLocaleString(_locales, _options) {
    return this.toString();
  }
  [Symbol.toStringTag]() {
    return "[object Array]";
  }
  static [Symbol.toStringTag]() {
    return this._capnp.displayName;
  }
}
function initList$1(elementSize, length, list, compositeSize) {
  let c;
  switch (elementSize) {
    case ListElementSize.BIT: {
      c = list.segment.allocate(Math.ceil(length / 8));
      break;
    }
    case ListElementSize.BYTE:
    case ListElementSize.BYTE_2:
    case ListElementSize.BYTE_4:
    case ListElementSize.BYTE_8:
    case ListElementSize.POINTER: {
      c = list.segment.allocate(length * getListElementByteLength(elementSize));
      break;
    }
    case ListElementSize.COMPOSITE: {
      if (compositeSize === void 0) {
        throw new Error(format(PTR_COMPOSITE_SIZE_UNDEFINED));
      }
      compositeSize = padToWord(compositeSize);
      const byteLength = getByteLength(compositeSize) * length;
      c = list.segment.allocate(byteLength + 8);
      setStructPointer(length, compositeSize, c);
      break;
    }
    case ListElementSize.VOID: {
      setListPointer(0, elementSize, length, list);
      return;
    }
    default: {
      throw new Error(format(PTR_INVALID_LIST_SIZE, elementSize));
    }
  }
  const res = initPointer(c.segment, c.byteOffset, list);
  setListPointer(
    res.offsetWords,
    elementSize,
    length,
    res.pointer,
    compositeSize
  );
}

class Data extends List {
  static fromPointer(pointer) {
    validate(PointerType.LIST, pointer, ListElementSize.BYTE);
    return this._fromPointerUnchecked(pointer);
  }
  static _fromPointerUnchecked(pointer) {
    return new this(
      pointer.segment,
      pointer.byteOffset,
      pointer._capnp.depthLimit
    );
  }
  /**
   * Copy the contents of `src` into this Data pointer. If `src` is smaller than the length of this pointer then the
   * remaining bytes will be zeroed out. Extra bytes in `src` are ignored.
   *
   * @param src The source buffer.
   */
  // TODO: Would be nice to have a way to zero-copy a buffer by allocating a new segment into the message with that
  // buffer data.
  copyBuffer(src) {
    const c = getContent(this);
    const dstLength = this.length;
    const srcLength = src.byteLength;
    const i = src instanceof ArrayBuffer ? new Uint8Array(src) : new Uint8Array(
      src.buffer,
      src.byteOffset,
      Math.min(dstLength, srcLength)
    );
    const o = new Uint8Array(c.segment.buffer, c.byteOffset, this.length);
    o.set(i);
    if (dstLength > srcLength) {
      o.fill(0, srcLength, dstLength);
    }
  }
  /**
   * Read a byte from the specified offset.
   *
   * @param byteOffset The byte offset to read.
   * @returns The byte value.
   */
  get(byteOffset) {
    const c = getContent(this);
    return c.segment.getUint8(c.byteOffset + byteOffset);
  }
  /**
   * Write a byte at the specified offset.
   *
   * @param byteOffset The byte offset to set.
   * @param value The byte value to set.
   */
  set(byteOffset, value) {
    const c = getContent(this);
    c.segment.setUint8(c.byteOffset + byteOffset, value);
  }
  /**
   * Creates a **copy** of the underlying buffer data and returns it as an ArrayBuffer.
   *
   * To obtain a reference to the underlying buffer instead, use `toUint8Array()` or `toDataView()`.
   *
   * @returns A copy of this data buffer.
   */
  toArrayBuffer() {
    const c = getContent(this);
    return c.segment.buffer.slice(c.byteOffset, c.byteOffset + this.length);
  }
  /**
   * Creates a **copy** of the underlying buffer data and returns it as a Uint8Array.
   *
   * To obtain a live reference to the underlying buffer instead, use `toUint8Array()`.
   *
   * @returns A Uint8Array copy of this data buffer.
   */
  copyToUint8Array() {
    return new Uint8Array(this.toArrayBuffer());
  }
  /**
   * Convert this Data pointer to a DataView representing the pointer's contents.
   *
   * WARNING: The DataView references memory from a message segment, so do not venture outside the bounds of the
   * DataView or else BAD THINGS.
   *
   * @returns A live reference to the underlying buffer.
   */
  toDataView() {
    const c = getContent(this);
    return new DataView(c.segment.buffer, c.byteOffset, this.length);
  }
  [Symbol.toStringTag]() {
    return `Data_${super.toString()}`;
  }
  /**
   * Convert this Data pointer to a Uint8Array representing the pointer's contents.
   *
   * WARNING: The Uint8Array references memory from a message segment, so do not venture outside the bounds of the
   * Uint8Array or else BAD THINGS.
   *
   * @returns A live reference to the underlying buffer.
   */
  toUint8Array() {
    const c = getContent(this);
    return new Uint8Array(c.segment.buffer, c.byteOffset, this.length);
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
class Text extends List {
  static fromPointer(pointer) {
    validate(PointerType.LIST, pointer, ListElementSize.BYTE);
    return textFromPointerUnchecked(pointer);
  }
  /**
   * Read a utf-8 encoded string value from this pointer.
   *
   * @param index The index at which to start reading; defaults to zero.
   * @returns The string value.
   */
  get(index = 0) {
    if (isNull(this)) {
      return "";
    }
    const c = getContent(this);
    return textDecoder.decode(
      new Uint8Array(
        c.segment.buffer,
        c.byteOffset + index,
        this.length - index
      )
    );
  }
  /**
   * Get the number of utf-8 encoded bytes in this text. This does **not** include the NUL byte.
   *
   * @returns The number of bytes allocated for the text.
   */
  get length() {
    return super.length - 1;
  }
  /**
   * Write a utf-8 encoded string value starting at the specified index.
   *
   * @param index The index at which to start copying the string. Note that if this is not zero the bytes
   * before `index` will be left as-is. All bytes after `index` will be overwritten.
   * @param value The string value to set.
   */
  set(index, value) {
    const src = textEncoder.encode(value);
    const dstLength = src.byteLength + index;
    let c;
    let original;
    if (!isNull(this)) {
      c = getContent(this);
      const originalLength = Math.min(this.length, index);
      original = new Uint8Array(
        c.segment.buffer.slice(c.byteOffset, c.byteOffset + originalLength)
      );
      erase(this);
    }
    initList$1(ListElementSize.BYTE, dstLength + 1, this);
    c = getContent(this);
    const dst = new Uint8Array(c.segment.buffer, c.byteOffset, dstLength);
    if (original) {
      dst.set(original);
    }
    dst.set(src, index);
  }
  toString() {
    return this.get();
  }
  toJSON() {
    return this.get();
  }
  [Symbol.toPrimitive]() {
    return this.get();
  }
  [Symbol.toStringTag]() {
    return `Text_${super.toString()}`;
  }
}
function textFromPointerUnchecked(pointer) {
  return new Text(
    pointer.segment,
    pointer.byteOffset,
    pointer._capnp.depthLimit
  );
}

class FixedAnswer {
  struct() {
    return Promise.resolve(this.structSync());
  }
}

class ErrorAnswer extends FixedAnswer {
  constructor(err) {
    super();
    this.err = err;
  }
  structSync() {
    throw this.err;
  }
  pipelineCall(_transform, _call) {
    return this;
  }
  pipelineClose(_transform) {
    throw this.err;
  }
}

class ErrorClient {
  constructor(err) {
    this.err = err;
  }
  call(_call) {
    return new ErrorAnswer(this.err);
  }
  close() {
  }
}
function clientOrNull(client) {
  return client ?? new ErrorClient(new Error(RPC_NULL_CLIENT));
}

const TMP_WORD = new DataView(new ArrayBuffer(8));
function initStruct(size, s) {
  if (s._capnp.compositeIndex !== void 0) {
    throw new Error(format(PTR_INIT_COMPOSITE_STRUCT, s));
  }
  erase(s);
  const c = s.segment.allocate(getByteLength(size));
  const res = initPointer(c.segment, c.byteOffset, s);
  setStructPointer(res.offsetWords, size, res.pointer);
}
function initStructAt(index, StructClass, p) {
  const s = getPointerAs(index, StructClass, p);
  initStruct(StructClass._capnp.size, s);
  return s;
}
function checkPointerBounds(index, s) {
  const { pointerLength } = getSize(s);
  if (index < 0 || index >= pointerLength) {
    throw new Error(
      format(PTR_STRUCT_POINTER_OUT_OF_BOUNDS, s, index, pointerLength)
    );
  }
}
function getInterfaceClientOrNullAt(index, s) {
  return getInterfaceClientOrNull(getPointer(index, s));
}
function getInterfaceClientOrNull(p) {
  let client = null;
  const capId = getInterfacePointer(p);
  const { capTable } = p.segment.message._capnp;
  if (capTable && capId >= 0 && capId < capTable.length) {
    client = capTable[capId];
  }
  return clientOrNull(client);
}
function resize(dstSize, s) {
  const srcSize = getSize(s);
  const srcContent = getContent(s);
  const dstContent = s.segment.allocate(getByteLength(dstSize));
  dstContent.segment.copyWords(
    dstContent.byteOffset,
    srcContent.segment,
    srcContent.byteOffset,
    Math.min(getDataWordLength(srcSize), getDataWordLength(dstSize))
  );
  const res = initPointer(dstContent.segment, dstContent.byteOffset, s);
  setStructPointer(res.offsetWords, dstSize, res.pointer);
  for (let i = 0; i < Math.min(srcSize.pointerLength, dstSize.pointerLength); i++) {
    const srcPtr = new Pointer(
      srcContent.segment,
      srcContent.byteOffset + srcSize.dataByteLength + i * 8
    );
    if (isNull(srcPtr)) {
      continue;
    }
    const srcPtrTarget = followFars(srcPtr);
    const srcPtrContent = getContent(srcPtr);
    const dstPtr = new Pointer(
      dstContent.segment,
      dstContent.byteOffset + dstSize.dataByteLength + i * 8
    );
    if (getTargetPointerType(srcPtr) === PointerType.LIST && getTargetListElementSize(srcPtr) === ListElementSize.COMPOSITE) {
      srcPtrContent.byteOffset -= 8;
    }
    const r = initPointer(
      srcPtrContent.segment,
      srcPtrContent.byteOffset,
      dstPtr
    );
    const a = srcPtrTarget.segment.getUint8(srcPtrTarget.byteOffset) & 3;
    const b = srcPtrTarget.segment.getUint32(srcPtrTarget.byteOffset + 4);
    r.pointer.segment.setUint32(r.pointer.byteOffset, a | r.offsetWords << 2);
    r.pointer.segment.setUint32(r.pointer.byteOffset + 4, b);
  }
  srcContent.segment.fillZeroWords(
    srcContent.byteOffset,
    getWordLength(srcSize)
  );
}
function getAs(StructClass, s) {
  return new StructClass(
    s.segment,
    s.byteOffset,
    s._capnp.depthLimit,
    s._capnp.compositeIndex
  );
}
function getBit(bitOffset, s, defaultMask) {
  const byteOffset = Math.floor(bitOffset / 8);
  const bitMask = 1 << bitOffset % 8;
  checkDataBounds(byteOffset, 1, s);
  const ds = getDataSection(s);
  const v = ds.segment.getUint8(ds.byteOffset + byteOffset);
  if (defaultMask === void 0) {
    return (v & bitMask) !== 0;
  }
  const defaultValue = defaultMask.getUint8(0);
  return ((v ^ defaultValue) & bitMask) !== 0;
}
function getData(index, s, defaultValue) {
  checkPointerBounds(index, s);
  const ps = getPointerSection(s);
  ps.byteOffset += index * 8;
  const l = new Data(ps.segment, ps.byteOffset, s._capnp.depthLimit - 1);
  if (isNull(l)) {
    if (defaultValue) {
      copyFrom(defaultValue, l);
    } else {
      initList$1(ListElementSize.BYTE, 0, l);
    }
  }
  return l;
}
function getDataSection(s) {
  return getContent(s);
}
function getFloat32(byteOffset, s, defaultMask) {
  checkDataBounds(byteOffset, 4, s);
  const ds = getDataSection(s);
  if (defaultMask === void 0) {
    return ds.segment.getFloat32(ds.byteOffset + byteOffset);
  }
  const v = ds.segment.getUint32(ds.byteOffset + byteOffset) ^ defaultMask.getUint32(0, true);
  TMP_WORD.setUint32(0, v, NATIVE_LITTLE_ENDIAN);
  return TMP_WORD.getFloat32(0, NATIVE_LITTLE_ENDIAN);
}
function getFloat64(byteOffset, s, defaultMask) {
  checkDataBounds(byteOffset, 8, s);
  const ds = getDataSection(s);
  if (defaultMask !== void 0) {
    const lo = ds.segment.getUint32(ds.byteOffset + byteOffset) ^ defaultMask.getUint32(0, true);
    const hi = ds.segment.getUint32(ds.byteOffset + byteOffset + 4) ^ defaultMask.getUint32(4, true);
    TMP_WORD.setUint32(0, lo, NATIVE_LITTLE_ENDIAN);
    TMP_WORD.setUint32(4, hi, NATIVE_LITTLE_ENDIAN);
    return TMP_WORD.getFloat64(0, NATIVE_LITTLE_ENDIAN);
  }
  return ds.segment.getFloat64(ds.byteOffset + byteOffset);
}
function getInt16(byteOffset, s, defaultMask) {
  checkDataBounds(byteOffset, 2, s);
  const ds = getDataSection(s);
  if (defaultMask === void 0) {
    return ds.segment.getInt16(ds.byteOffset + byteOffset);
  }
  const v = ds.segment.getUint16(ds.byteOffset + byteOffset) ^ defaultMask.getUint16(0, true);
  TMP_WORD.setUint16(0, v, NATIVE_LITTLE_ENDIAN);
  return TMP_WORD.getInt16(0, NATIVE_LITTLE_ENDIAN);
}
function getInt32(byteOffset, s, defaultMask) {
  checkDataBounds(byteOffset, 4, s);
  const ds = getDataSection(s);
  if (defaultMask === void 0) {
    return ds.segment.getInt32(ds.byteOffset + byteOffset);
  }
  const v = ds.segment.getUint32(ds.byteOffset + byteOffset) ^ defaultMask.getUint16(0, true);
  TMP_WORD.setUint32(0, v, NATIVE_LITTLE_ENDIAN);
  return TMP_WORD.getInt32(0, NATIVE_LITTLE_ENDIAN);
}
function getInt64(byteOffset, s, defaultMask) {
  checkDataBounds(byteOffset, 8, s);
  const ds = getDataSection(s);
  if (defaultMask !== void 0) {
    const lo = ds.segment.getUint32(ds.byteOffset + byteOffset) ^ defaultMask.getUint32(0, true);
    const hi = ds.segment.getUint32(ds.byteOffset + byteOffset + 4) ^ defaultMask.getUint32(4, true);
    TMP_WORD.setUint32(NATIVE_LITTLE_ENDIAN ? 0 : 4, lo, NATIVE_LITTLE_ENDIAN);
    TMP_WORD.setUint32(NATIVE_LITTLE_ENDIAN ? 4 : 0, hi, NATIVE_LITTLE_ENDIAN);
    return TMP_WORD.getBigInt64(0, NATIVE_LITTLE_ENDIAN);
  }
  return ds.segment.getInt64(ds.byteOffset + byteOffset);
}
function getInt8(byteOffset, s, defaultMask) {
  checkDataBounds(byteOffset, 1, s);
  const ds = getDataSection(s);
  if (defaultMask === void 0) {
    return ds.segment.getInt8(ds.byteOffset + byteOffset);
  }
  const v = ds.segment.getUint8(ds.byteOffset + byteOffset) ^ defaultMask.getUint8(0);
  TMP_WORD.setUint8(0, v);
  return TMP_WORD.getInt8(0);
}
function getList(index, ListClass, s, defaultValue) {
  checkPointerBounds(index, s);
  const ps = getPointerSection(s);
  ps.byteOffset += index * 8;
  const l = new ListClass(ps.segment, ps.byteOffset, s._capnp.depthLimit - 1);
  if (isNull(l)) {
    if (defaultValue) {
      copyFrom(defaultValue, l);
    } else {
      initList$1(ListClass._capnp.size, 0, l, ListClass._capnp.compositeSize);
    }
  } else if (ListClass._capnp.compositeSize !== void 0) {
    const srcSize = getTargetCompositeListSize(l);
    const dstSize = ListClass._capnp.compositeSize;
    if (dstSize.dataByteLength > srcSize.dataByteLength || dstSize.pointerLength > srcSize.pointerLength) {
      const srcContent = getContent(l);
      const srcLength = getTargetListLength(l);
      const dstContent = l.segment.allocate(
        getByteLength(dstSize) * srcLength + 8
      );
      const res = initPointer(dstContent.segment, dstContent.byteOffset, l);
      setListPointer(
        res.offsetWords,
        ListClass._capnp.size,
        srcLength,
        res.pointer,
        dstSize
      );
      setStructPointer(srcLength, dstSize, dstContent);
      dstContent.byteOffset += 8;
      for (let i = 0; i < srcLength; i++) {
        const srcElementOffset = srcContent.byteOffset + i * getByteLength(srcSize);
        const dstElementOffset = dstContent.byteOffset + i * getByteLength(dstSize);
        dstContent.segment.copyWords(
          dstElementOffset,
          srcContent.segment,
          srcElementOffset,
          getWordLength(srcSize)
        );
        for (let j = 0; j < srcSize.pointerLength; j++) {
          const srcPtr = new Pointer(
            srcContent.segment,
            srcElementOffset + srcSize.dataByteLength + j * 8
          );
          const dstPtr = new Pointer(
            dstContent.segment,
            dstElementOffset + dstSize.dataByteLength + j * 8
          );
          const srcPtrTarget = followFars(srcPtr);
          const srcPtrContent = getContent(srcPtr);
          if (getTargetPointerType(srcPtr) === PointerType.LIST && getTargetListElementSize(srcPtr) === ListElementSize.COMPOSITE) {
            srcPtrContent.byteOffset -= 8;
          }
          const r = initPointer(
            srcPtrContent.segment,
            srcPtrContent.byteOffset,
            dstPtr
          );
          const a = srcPtrTarget.segment.getUint8(srcPtrTarget.byteOffset) & 3;
          const b = srcPtrTarget.segment.getUint32(srcPtrTarget.byteOffset + 4);
          r.pointer.segment.setUint32(
            r.pointer.byteOffset,
            a | r.offsetWords << 2
          );
          r.pointer.segment.setUint32(r.pointer.byteOffset + 4, b);
        }
      }
      srcContent.segment.fillZeroWords(
        srcContent.byteOffset,
        getWordLength(srcSize) * srcLength
      );
    }
  }
  return l;
}
function getPointer(index, s) {
  checkPointerBounds(index, s);
  const ps = getPointerSection(s);
  ps.byteOffset += index * 8;
  return new Pointer(ps.segment, ps.byteOffset, s._capnp.depthLimit - 1);
}
function getPointerAs(index, PointerClass, s) {
  checkPointerBounds(index, s);
  const ps = getPointerSection(s);
  ps.byteOffset += index * 8;
  return new PointerClass(ps.segment, ps.byteOffset, s._capnp.depthLimit - 1);
}
function getPointerSection(s) {
  const ps = getContent(s);
  ps.byteOffset += padToWord$1(getSize(s).dataByteLength);
  return ps;
}
function getSize(s) {
  if (s._capnp.compositeIndex !== void 0) {
    const c = getContent(s, true);
    c.byteOffset -= 8;
    return getStructSize(c);
  }
  return getTargetStructSize(s);
}
function getStruct(index, StructClass, s, defaultValue) {
  const t = getPointerAs(index, StructClass, s);
  if (isNull(t)) {
    if (defaultValue) {
      copyFrom(defaultValue, t);
    } else {
      initStruct(StructClass._capnp.size, t);
    }
  } else {
    validate(PointerType.STRUCT, t);
    const ts = getTargetStructSize(t);
    if (ts.dataByteLength < StructClass._capnp.size.dataByteLength || ts.pointerLength < StructClass._capnp.size.pointerLength) {
      resize(StructClass._capnp.size, t);
    }
  }
  return t;
}
function getText(index, s, defaultValue) {
  const t = Text.fromPointer(getPointer(index, s));
  if (isNull(t) && defaultValue) {
    t.set(0, defaultValue);
  }
  return t.get(0);
}
function getUint16(byteOffset, s, defaultMask) {
  checkDataBounds(byteOffset, 2, s);
  const ds = getDataSection(s);
  if (defaultMask === void 0) {
    return ds.segment.getUint16(ds.byteOffset + byteOffset);
  }
  return ds.segment.getUint16(ds.byteOffset + byteOffset) ^ defaultMask.getUint16(0, true);
}
function getUint32(byteOffset, s, defaultMask) {
  checkDataBounds(byteOffset, 4, s);
  const ds = getDataSection(s);
  if (defaultMask === void 0) {
    return ds.segment.getUint32(ds.byteOffset + byteOffset);
  }
  return ds.segment.getUint32(ds.byteOffset + byteOffset) ^ defaultMask.getUint32(0, true);
}
function getUint64(byteOffset, s, defaultMask) {
  checkDataBounds(byteOffset, 8, s);
  const ds = getDataSection(s);
  if (defaultMask !== void 0) {
    const lo = ds.segment.getUint32(ds.byteOffset + byteOffset) ^ defaultMask.getUint32(0, true);
    const hi = ds.segment.getUint32(ds.byteOffset + byteOffset + 4) ^ defaultMask.getUint32(4, true);
    TMP_WORD.setUint32(NATIVE_LITTLE_ENDIAN ? 0 : 4, lo, NATIVE_LITTLE_ENDIAN);
    TMP_WORD.setUint32(NATIVE_LITTLE_ENDIAN ? 4 : 0, hi, NATIVE_LITTLE_ENDIAN);
    return TMP_WORD.getBigUint64(0, NATIVE_LITTLE_ENDIAN);
  }
  return ds.segment.getUint64(ds.byteOffset + byteOffset);
}
function getUint8(byteOffset, s, defaultMask) {
  checkDataBounds(byteOffset, 1, s);
  const ds = getDataSection(s);
  if (defaultMask === void 0) {
    return ds.segment.getUint8(ds.byteOffset + byteOffset);
  }
  return ds.segment.getUint8(ds.byteOffset + byteOffset) ^ defaultMask.getUint8(0);
}
function initData(index, length, s) {
  checkPointerBounds(index, s);
  const ps = getPointerSection(s);
  ps.byteOffset += index * 8;
  const l = new Data(ps.segment, ps.byteOffset, s._capnp.depthLimit - 1);
  erase(l);
  initList$1(ListElementSize.BYTE, length, l);
  return l;
}
function initList(index, ListClass, length, s) {
  checkPointerBounds(index, s);
  const ps = getPointerSection(s);
  ps.byteOffset += index * 8;
  const l = new ListClass(ps.segment, ps.byteOffset, s._capnp.depthLimit - 1);
  erase(l);
  initList$1(ListClass._capnp.size, length, l, ListClass._capnp.compositeSize);
  return l;
}
function setBit(bitOffset, value, s, defaultMask) {
  const byteOffset = Math.floor(bitOffset / 8);
  const bitMask = 1 << bitOffset % 8;
  checkDataBounds(byteOffset, 1, s);
  const ds = getDataSection(s);
  const b = ds.segment.getUint8(ds.byteOffset + byteOffset);
  if (defaultMask !== void 0) {
    value = (defaultMask.getUint8(0) & bitMask) === 0 ? value : !value;
  }
  ds.segment.setUint8(
    ds.byteOffset + byteOffset,
    value ? b | bitMask : b & ~bitMask
  );
}
function setFloat32(byteOffset, value, s, defaultMask) {
  checkDataBounds(byteOffset, 4, s);
  const ds = getDataSection(s);
  if (defaultMask !== void 0) {
    TMP_WORD.setFloat32(0, value, NATIVE_LITTLE_ENDIAN);
    const v = TMP_WORD.getUint32(0, NATIVE_LITTLE_ENDIAN) ^ defaultMask.getUint32(0, true);
    ds.segment.setUint32(ds.byteOffset + byteOffset, v);
    return;
  }
  ds.segment.setFloat32(ds.byteOffset + byteOffset, value);
}
function setFloat64(byteOffset, value, s, defaultMask) {
  checkDataBounds(byteOffset, 8, s);
  const ds = getDataSection(s);
  if (defaultMask !== void 0) {
    TMP_WORD.setFloat64(0, value, NATIVE_LITTLE_ENDIAN);
    const lo = TMP_WORD.getUint32(0, NATIVE_LITTLE_ENDIAN) ^ defaultMask.getUint32(0, true);
    const hi = TMP_WORD.getUint32(4, NATIVE_LITTLE_ENDIAN) ^ defaultMask.getUint32(4, true);
    ds.segment.setUint32(ds.byteOffset + byteOffset, lo);
    ds.segment.setUint32(ds.byteOffset + byteOffset + 4, hi);
    return;
  }
  ds.segment.setFloat64(ds.byteOffset + byteOffset, value);
}
function setInt16(byteOffset, value, s, defaultMask) {
  checkDataBounds(byteOffset, 2, s);
  const ds = getDataSection(s);
  if (defaultMask !== void 0) {
    TMP_WORD.setInt16(0, value, NATIVE_LITTLE_ENDIAN);
    const v = TMP_WORD.getUint16(0, NATIVE_LITTLE_ENDIAN) ^ defaultMask.getUint16(0, true);
    ds.segment.setUint16(ds.byteOffset + byteOffset, v);
    return;
  }
  ds.segment.setInt16(ds.byteOffset + byteOffset, value);
}
function setInt32(byteOffset, value, s, defaultMask) {
  checkDataBounds(byteOffset, 4, s);
  const ds = getDataSection(s);
  if (defaultMask !== void 0) {
    TMP_WORD.setInt32(0, value, NATIVE_LITTLE_ENDIAN);
    const v = TMP_WORD.getUint32(0, NATIVE_LITTLE_ENDIAN) ^ defaultMask.getUint32(0, true);
    ds.segment.setUint32(ds.byteOffset + byteOffset, v);
    return;
  }
  ds.segment.setInt32(ds.byteOffset + byteOffset, value);
}
function setInt64(byteOffset, value, s, defaultMask) {
  checkDataBounds(byteOffset, 8, s);
  const ds = getDataSection(s);
  if (defaultMask !== void 0) {
    TMP_WORD.setBigInt64(0, value, NATIVE_LITTLE_ENDIAN);
    const lo = TMP_WORD.getUint32(NATIVE_LITTLE_ENDIAN ? 0 : 4, NATIVE_LITTLE_ENDIAN) ^ defaultMask.getUint32(0, true);
    const hi = TMP_WORD.getUint32(NATIVE_LITTLE_ENDIAN ? 4 : 0, NATIVE_LITTLE_ENDIAN) ^ defaultMask.getUint32(4, true);
    ds.segment.setUint32(ds.byteOffset + byteOffset, lo);
    ds.segment.setUint32(ds.byteOffset + byteOffset + 4, hi);
    return;
  }
  ds.segment.setInt64(ds.byteOffset + byteOffset, value);
}
function setInt8(byteOffset, value, s, defaultMask) {
  checkDataBounds(byteOffset, 1, s);
  const ds = getDataSection(s);
  if (defaultMask !== void 0) {
    TMP_WORD.setInt8(0, value);
    const v = TMP_WORD.getUint8(0) ^ defaultMask.getUint8(0);
    ds.segment.setUint8(ds.byteOffset + byteOffset, v);
    return;
  }
  ds.segment.setInt8(ds.byteOffset + byteOffset, value);
}
function setText(index, value, s) {
  Text.fromPointer(getPointer(index, s)).set(0, value);
}
function setUint16(byteOffset, value, s, defaultMask) {
  checkDataBounds(byteOffset, 2, s);
  const ds = getDataSection(s);
  if (defaultMask !== void 0) {
    value ^= defaultMask.getUint16(0, true);
  }
  ds.segment.setUint16(ds.byteOffset + byteOffset, value);
}
function setUint32(byteOffset, value, s, defaultMask) {
  checkDataBounds(byteOffset, 4, s);
  const ds = getDataSection(s);
  if (defaultMask !== void 0) {
    value ^= defaultMask.getUint32(0, true);
  }
  ds.segment.setUint32(ds.byteOffset + byteOffset, value);
}
function setUint64(byteOffset, value, s, defaultMask) {
  checkDataBounds(byteOffset, 8, s);
  const ds = getDataSection(s);
  if (defaultMask !== void 0) {
    TMP_WORD.setBigUint64(0, value, NATIVE_LITTLE_ENDIAN);
    const lo = TMP_WORD.getUint32(NATIVE_LITTLE_ENDIAN ? 0 : 4, NATIVE_LITTLE_ENDIAN) ^ defaultMask.getUint32(0, true);
    const hi = TMP_WORD.getUint32(NATIVE_LITTLE_ENDIAN ? 4 : 0, NATIVE_LITTLE_ENDIAN) ^ defaultMask.getUint32(4, true);
    ds.segment.setUint32(ds.byteOffset + byteOffset, lo);
    ds.segment.setUint32(ds.byteOffset + byteOffset + 4, hi);
    return;
  }
  ds.segment.setUint64(ds.byteOffset + byteOffset, value);
}
function setUint8(byteOffset, value, s, defaultMask) {
  checkDataBounds(byteOffset, 1, s);
  const ds = getDataSection(s);
  if (defaultMask !== void 0) {
    value ^= defaultMask.getUint8(0);
  }
  ds.segment.setUint8(ds.byteOffset + byteOffset, value);
}
function testWhich(name, found, wanted, s) {
  if (found !== wanted) {
    throw new Error(format(PTR_INVALID_UNION_ACCESS, s, name, found, wanted));
  }
}
function checkDataBounds(byteOffset, byteLength, s) {
  const { dataByteLength } = getSize(s);
  if (byteOffset < 0 || byteLength < 0 || byteOffset + byteLength > dataByteLength) {
    throw new Error(
      format(
        PTR_STRUCT_DATA_OUT_OF_BOUNDS,
        s,
        byteLength,
        byteOffset,
        dataByteLength
      )
    );
  }
}

export { setInt64 as A, getFloat32 as B, setFloat32 as C, getFloat64 as D, ErrorAnswer as E, setFloat64 as F, getData as G, initData as H, resize as I, initStruct as J, FixedAnswer as K, List as L, getInterfaceClientOrNull as M, ErrorClient as N, checkDataBounds as O, checkPointerBounds as P, getDataSection as Q, getInterfaceClientOrNullAt as R, getPointerAs as S, getPointerSection as T, getSize as U, Data as V, Text as W, clientOrNull as X, getUint16 as a, getUint32 as b, setUint32 as c, getBit as d, setBit as e, getStruct as f, getPointer as g, getUint64 as h, initStructAt as i, setUint64 as j, getAs as k, getList as l, initList as m, getUint8 as n, setUint8 as o, getText as p, setText as q, getInt8 as r, setUint16 as s, testWhich as t, setInt8 as u, getInt16 as v, setInt16 as w, getInt32 as x, setInt32 as y, getInt64 as z };
