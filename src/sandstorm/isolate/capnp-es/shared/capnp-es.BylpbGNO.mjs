var ListElementSize = /* @__PURE__ */ ((ListElementSize2) => {
  ListElementSize2[ListElementSize2["VOID"] = 0] = "VOID";
  ListElementSize2[ListElementSize2["BIT"] = 1] = "BIT";
  ListElementSize2[ListElementSize2["BYTE"] = 2] = "BYTE";
  ListElementSize2[ListElementSize2["BYTE_2"] = 3] = "BYTE_2";
  ListElementSize2[ListElementSize2["BYTE_4"] = 4] = "BYTE_4";
  ListElementSize2[ListElementSize2["BYTE_8"] = 5] = "BYTE_8";
  ListElementSize2[ListElementSize2["POINTER"] = 6] = "POINTER";
  ListElementSize2[ListElementSize2["COMPOSITE"] = 7] = "COMPOSITE";
  return ListElementSize2;
})(ListElementSize || {});

const tmpWord = new DataView(new ArrayBuffer(8));
new Uint16Array(tmpWord.buffer)[0] = 258;
const DEFAULT_BUFFER_SIZE = 256;
const DEFAULT_TRAVERSE_LIMIT = 64 << 20;
const LIST_SIZE_MASK = 7;
const MAX_BUFFER_DUMP_BYTES = 8192;
const MAX_INT32 = 2147483647;
const MAX_UINT32 = 4294967295;
const MIN_SINGLE_SEGMENT_GROWTH = 1024;
const NATIVE_LITTLE_ENDIAN = tmpWord.getUint8(0) === 2;
const PACK_SPAN_THRESHOLD = 2;
const POINTER_DOUBLE_FAR_MASK = 4;
const POINTER_TYPE_MASK = 3;
const MAX_DEPTH = MAX_INT32;
const MAX_SEGMENT_LENGTH = MAX_UINT32;

const INVARIANT_UNREACHABLE_CODE = "CAPNP-TS000 Unreachable code detected.";
function assertNever(n) {
  throw new Error(INVARIANT_UNREACHABLE_CODE + ` (never block hit with: ${n})`);
}
const MSG_INVALID_FRAME_HEADER = "CAPNP-TS001 Attempted to parse an invalid message frame header; are you sure this is a Cap'n Proto message?";
const MSG_PACK_NOT_WORD_ALIGNED = "CAPNP-TS003 Attempted to pack a message that was not word-aligned.";
const MSG_SEGMENT_OUT_OF_BOUNDS = "CAPNP-TS004 Segment ID %X is out of bounds for message %s.";
const MSG_SEGMENT_TOO_SMALL = "CAPNP-TS005 First segment must have at least enough room to hold the root pointer (8 bytes).";
const PTR_ADOPT_WRONG_MESSAGE = "CAPNP-TS008 Attempted to adopt %s into a pointer in a different message %s.";
const PTR_ALREADY_ADOPTED = "CAPNP-TS009 Attempted to adopt %s more than once.";
const PTR_COMPOSITE_SIZE_UNDEFINED = "CAPNP-TS010 Attempted to set a composite list without providing a composite element size.";
const PTR_DEPTH_LIMIT_EXCEEDED = "CAPNP-TS011 Nesting depth limit exceeded for %s.";
const PTR_INIT_COMPOSITE_STRUCT = "CAPNP-TS013 Attempted to initialize a struct member from a composite list (%s).";
const PTR_INVALID_FAR_TARGET = "CAPNP-TS015 Target of a far pointer (%s) is another far pointer.";
const PTR_INVALID_LIST_SIZE = "CAPNP-TS016 Invalid list element size: %x.";
const PTR_INVALID_POINTER_TYPE = "CAPNP-TS017 Invalid pointer type: %x.";
const PTR_INVALID_UNION_ACCESS = "CAPNP-TS018 Attempted to access getter on %s for union field %s that is not currently set (wanted: %d, found: %d).";
const PTR_OFFSET_OUT_OF_BOUNDS = "CAPNP-TS019 Pointer offset %a is out of bounds for underlying buffer.";
const PTR_STRUCT_DATA_OUT_OF_BOUNDS = "CAPNP-TS020 Attempted to access out-of-bounds struct data (struct: %s, %d bytes at %a, data words: %d).";
const PTR_STRUCT_POINTER_OUT_OF_BOUNDS = "CAPNP-TS021 Attempted to access out-of-bounds struct pointer (%s, index: %d, length: %d).";
const PTR_TRAVERSAL_LIMIT_EXCEEDED = "CAPNP-TS022 Traversal limit exceeded! Slow down! %s";
const PTR_WRONG_LIST_TYPE = "CAPNP-TS023 Cannot convert %s to a %s list.";
const PTR_WRONG_POINTER_TYPE = "CAPNP-TS024 Attempted to convert pointer %s to a %s type.";
const SEG_GET_NON_ZERO_SINGLE = "CAPNP-TS035 Attempted to get a segment other than 0 (%d) from a single segment arena.";
const SEG_ID_OUT_OF_BOUNDS = "CAPNP-TS036 Attempted to get an out-of-bounds segment (%d).";
const SEG_NOT_WORD_ALIGNED = "CAPNP-TS037 Segment buffer length %d is not a multiple of 8.";
const SEG_REPLACEMENT_BUFFER_TOO_SMALL = "CAPNP-TS038 Attempted to replace a segment buffer with one that is smaller than the allocated space.";
const SEG_SIZE_OVERFLOW = `CAPNP-TS039 Requested size %x exceeds maximum value (${MAX_SEGMENT_LENGTH}).`;
const TYPE_COMPOSITE_SIZE_UNDEFINED = "CAPNP-TS040 Must provide a composite element size for composite list pointers.";
const LIST_NO_MUTABLE = "CAPNP-TS045: Cannot call mutative methods on an immutable list.";
const LIST_NO_SEARCH = "CAPNP-TS046: Search is not supported for list.";
const RPC_NULL_CLIENT = "CAPNP-TS100 Call on null client.";
const RPC_CALL_QUEUE_FULL = "CAPNP-TS101 Promised answer call queue full.";
const RPC_QUEUE_CALL_CANCEL = "CAPNP-TS102 Queue call canceled.";
const RPC_ZERO_REF = "CAPNP-TS105 Ref() called on zeroed refcount.";
const RPC_IMPORT_CLOSED = "CAPNP-TS106 Call on closed import.";
const RPC_METHOD_NOT_IMPLEMENTED = "CAPNP-TS107 Method not implemented.";
const RPC_UNIMPLEMENTED = "CAPNP-TS108 Remote used unimplemented feature.";
const RPC_BAD_TARGET = "CAPNP-TS109 Target not found.";
const RPC_RETURN_FOR_UNKNOWN_QUESTION = "CAPNP-TS111 Received return for unknown question (id=%s).";
const RPC_QUESTION_ID_REUSED = "CAPNP-TS112 Attempted to re-use question id (%s).";
const RPC_UNKNOWN_EXPORT_ID = "CAPNP-TS113 Capability table references unknown export ID (%s).";
const RPC_UNKNOWN_ANSWER_ID = "CAPNP-TS114 Capability table references unknown answer ID (%s).";
const RPC_UNKNOWN_CAP_DESCRIPTOR = "CAPNP-TS115 Unknown cap descriptor type (which: %s).";
const RPC_METHOD_ERROR = "CAPNP-TS116 RPC method failed at %s.%s(): %s";
const RPC_ERROR = "CAPNP-TS117 RPC call failed, reason: %s";
const RPC_NO_MAIN_INTERFACE = "CAPNP-TS118 Received bootstrap message without main interface set.";
const RPC_FULFILL_ALREADY_CALLED = "CAPNP-TS120 Fulfill called more than once for question (%s).";

function bufferToHex(buffer) {
  const a = new Uint8Array(buffer);
  const h = [];
  for (let i = 0; i < a.byteLength; i++) {
    h.push(pad(a[i].toString(16), 2));
  }
  return `[${h.join(" ")}]`;
}
function dumpBuffer(buffer) {
  const b = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const byteLength = Math.min(b.byteLength, MAX_BUFFER_DUMP_BYTES);
  let r = format("\n=== buffer[%d] ===", byteLength);
  for (let j = 0; j < byteLength; j += 16) {
    r += `
${pad(j.toString(16), 8)}: `;
    let s = "";
    let k;
    for (k = 0; k < 16 && j + k < b.byteLength; k++) {
      const v = b[j + k];
      r += `${pad(v.toString(16), 2)} `;
      s += v > 31 && v < 255 ? String.fromCharCode(v) : "\xB7";
      if (k === 7) {
        r += " ";
      }
    }
    r += `${" ".repeat((17 - k) * 3)}${s}`;
  }
  r += "\n";
  if (byteLength !== b.byteLength) {
    r += format("=== (truncated %d bytes) ===\n", b.byteLength - byteLength);
  }
  return r;
}
function format(s, ...args) {
  const n = s.length;
  let arg;
  let argIndex = 0;
  let c;
  let escaped = false;
  let i = 0;
  let leadingZero = false;
  let precision;
  let result = "";
  function nextArg() {
    return args[argIndex++];
  }
  function slurpNumber() {
    let digits = "";
    while (/\d/.test(s[i])) {
      digits += s[i++];
      c = s[i];
    }
    return digits.length > 0 ? Number.parseInt(digits, 10) : null;
  }
  for (; i < n; ++i) {
    c = s[i];
    if (escaped) {
      escaped = false;
      if (c === ".") {
        leadingZero = false;
        c = s[++i];
      } else if (c === "0" && s[i + 1] === ".") {
        leadingZero = true;
        i += 2;
        c = s[i];
      } else {
        leadingZero = true;
      }
      precision = slurpNumber();
      switch (c) {
        case "a": {
          result += "0x" + pad(Number.parseInt(String(nextArg()), 10).toString(16), 8);
          break;
        }
        case "b": {
          result += Number.parseInt(String(nextArg()), 10).toString(2);
          break;
        }
        case "c": {
          arg = nextArg();
          result += typeof arg === "string" || arg instanceof String ? arg : String.fromCharCode(Number.parseInt(String(arg), 10));
          break;
        }
        case "d": {
          result += Number.parseInt(String(nextArg()), 10);
          break;
        }
        case "f": {
          const tmp = Number.parseFloat(String(nextArg())).toFixed(
            precision || 6
          );
          result += leadingZero ? tmp : tmp.replace(/^0/, "");
          break;
        }
        case "j": {
          result += JSON.stringify(nextArg());
          break;
        }
        case "o": {
          result += "0" + Number.parseInt(String(nextArg()), 10).toString(8);
          break;
        }
        case "s": {
          result += nextArg();
          break;
        }
        case "x": {
          result += "0x" + Number.parseInt(String(nextArg()), 10).toString(16);
          break;
        }
        case "X": {
          result += "0x" + Number.parseInt(String(nextArg()), 10).toString(16).toUpperCase();
          break;
        }
        default: {
          result += c;
          break;
        }
      }
    } else if (c === "%") {
      escaped = true;
    } else {
      result += c;
    }
  }
  return result;
}
function pad(v, width, pad2 = "0") {
  return v.length >= width ? v : Array.from({ length: width - v.length + 1 }).join(pad2) + v;
}
function padToWord$1(size) {
  return size + 7 & -8;
}

class ObjectSize {
  /**
   * Creates a new ObjectSize instance.
   *
   * @param dataByteLength - The number of bytes in the data section of the struct
   * @param pointerLength - The number of pointers in the pointer section of the struct
   */
  constructor(dataByteLength, pointerLength) {
    this.dataByteLength = dataByteLength;
    this.pointerLength = pointerLength;
  }
  toString() {
    return format(
      "ObjectSize_dw:%d,pc:%d",
      getDataWordLength(this),
      this.pointerLength
    );
  }
}
function getByteLength(o) {
  return o.dataByteLength + o.pointerLength * 8;
}
function getDataWordLength(o) {
  return o.dataByteLength / 8;
}
function getWordLength(o) {
  return o.dataByteLength / 8 + o.pointerLength;
}
function padToWord(o) {
  return new ObjectSize(padToWord$1(o.dataByteLength), o.pointerLength);
}

class Orphan {
  /** If this member is not present then the orphan has already been adopted, or something went very wrong. */
  _capnp;
  byteOffset;
  segment;
  constructor(src) {
    const c = getContent(src);
    this.segment = c.segment;
    this.byteOffset = c.byteOffset;
    this._capnp = {};
    this._capnp.type = getTargetPointerType(src);
    switch (this._capnp.type) {
      case PointerType.STRUCT: {
        this._capnp.size = getTargetStructSize(src);
        break;
      }
      case PointerType.LIST: {
        this._capnp.length = getTargetListLength(src);
        this._capnp.elementSize = getTargetListElementSize(src);
        if (this._capnp.elementSize === ListElementSize.COMPOSITE) {
          this._capnp.size = getTargetCompositeListSize(src);
        }
        break;
      }
      case PointerType.OTHER: {
        this._capnp.capId = getCapabilityId(src);
        break;
      }
      default: {
        throw new Error(PTR_INVALID_POINTER_TYPE);
      }
    }
    erasePointer(src);
  }
  /**
   * Adopt (move) this orphan into the target pointer location. This will allocate far pointers in `dst` as needed.
   *
   * @param dst The destination pointer.
   */
  _moveTo(dst) {
    if (this._capnp === void 0) {
      throw new Error(format(PTR_ALREADY_ADOPTED, this));
    }
    if (this.segment.message !== dst.segment.message) {
      throw new Error(format(PTR_ADOPT_WRONG_MESSAGE, this, dst));
    }
    erase(dst);
    const res = initPointer(this.segment, this.byteOffset, dst);
    switch (this._capnp.type) {
      case PointerType.STRUCT: {
        setStructPointer(res.offsetWords, this._capnp.size, res.pointer);
        break;
      }
      case PointerType.LIST: {
        let { offsetWords } = res;
        if (this._capnp.elementSize === ListElementSize.COMPOSITE) {
          offsetWords--;
        }
        setListPointer(
          offsetWords,
          this._capnp.elementSize,
          this._capnp.length,
          res.pointer,
          this._capnp.size
        );
        break;
      }
      case PointerType.OTHER: {
        setInterfacePointer(this._capnp.capId, res.pointer);
        break;
      }
      /* istanbul ignore next */
      default: {
        throw new Error(PTR_INVALID_POINTER_TYPE);
      }
    }
    this._capnp = void 0;
  }
  dispose() {
    if (this._capnp === void 0) {
      return;
    }
    switch (this._capnp.type) {
      case PointerType.STRUCT: {
        this.segment.fillZeroWords(
          this.byteOffset,
          getWordLength(this._capnp.size)
        );
        break;
      }
      case PointerType.LIST: {
        const byteLength = getListByteLength(
          this._capnp.elementSize,
          this._capnp.length,
          this._capnp.size
        );
        this.segment.fillZeroWords(this.byteOffset, byteLength);
        break;
      }
    }
    this._capnp = void 0;
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return format(
      "Orphan_%d@%a,type:%s",
      this.segment.id,
      this.byteOffset,
      this._capnp && this._capnp.type
    );
  }
}

function adopt(src, p) {
  src._moveTo(p);
}
function disown(p) {
  return new Orphan(p);
}
function dump(p) {
  return bufferToHex(p.segment.buffer.slice(p.byteOffset, p.byteOffset + 8));
}
function getListByteLength(elementSize, length, compositeSize) {
  switch (elementSize) {
    case ListElementSize.BIT: {
      return padToWord$1(length + 7 >>> 3);
    }
    case ListElementSize.BYTE:
    case ListElementSize.BYTE_2:
    case ListElementSize.BYTE_4:
    case ListElementSize.BYTE_8:
    case ListElementSize.POINTER:
    case ListElementSize.VOID: {
      return padToWord$1(getListElementByteLength(elementSize) * length);
    }
    /* istanbul ignore next */
    case ListElementSize.COMPOSITE: {
      if (compositeSize === void 0) {
        throw new Error(format(PTR_INVALID_LIST_SIZE, Number.NaN));
      }
      return length * padToWord$1(getByteLength(compositeSize));
    }
    /* istanbul ignore next */
    default: {
      throw new Error(PTR_INVALID_LIST_SIZE);
    }
  }
}
function getListElementByteLength(elementSize) {
  switch (elementSize) {
    /* istanbul ignore next */
    case ListElementSize.BIT: {
      return Number.NaN;
    }
    case ListElementSize.BYTE: {
      return 1;
    }
    case ListElementSize.BYTE_2: {
      return 2;
    }
    case ListElementSize.BYTE_4: {
      return 4;
    }
    case ListElementSize.BYTE_8:
    case ListElementSize.POINTER: {
      return 8;
    }
    /* istanbul ignore next */
    case ListElementSize.COMPOSITE: {
      return Number.NaN;
    }
    /* istanbul ignore next */
    case ListElementSize.VOID: {
      return 0;
    }
    /* istanbul ignore next */
    default: {
      throw new Error(format(PTR_INVALID_LIST_SIZE, elementSize));
    }
  }
}
function add(offset, p) {
  return new Pointer(p.segment, p.byteOffset + offset, p._capnp.depthLimit);
}
function copyFrom(src, p) {
  if (p.segment === src.segment && p.byteOffset === src.byteOffset) {
    return;
  }
  erase(p);
  if (isNull(src)) return;
  switch (getTargetPointerType(src)) {
    case PointerType.STRUCT: {
      copyFromStruct(src, p);
      break;
    }
    case PointerType.LIST: {
      copyFromList(src, p);
      break;
    }
    case PointerType.OTHER: {
      copyFromInterface(src, p);
      break;
    }
    /* istanbul ignore next */
    default: {
      throw new Error(
        format(PTR_INVALID_POINTER_TYPE, getTargetPointerType(p))
      );
    }
  }
}
function erase(p) {
  if (isNull(p)) return;
  let c;
  switch (getTargetPointerType(p)) {
    case PointerType.STRUCT: {
      const size = getTargetStructSize(p);
      c = getContent(p);
      c.segment.fillZeroWords(c.byteOffset, size.dataByteLength / 8);
      for (let i = 0; i < size.pointerLength; i++) {
        erase(add(i * 8, c));
      }
      break;
    }
    case PointerType.LIST: {
      const elementSize = getTargetListElementSize(p);
      const length = getTargetListLength(p);
      let contentWords = padToWord$1(length * getListElementByteLength(elementSize)) / 8;
      c = getContent(p);
      if (elementSize === ListElementSize.POINTER) {
        for (let i = 0; i < length; i++) {
          erase(
            new Pointer(
              c.segment,
              c.byteOffset + i * 8,
              p._capnp.depthLimit - 1
            )
          );
        }
        break;
      } else if (elementSize === ListElementSize.COMPOSITE) {
        const tag = add(-8, c);
        const compositeSize = getStructSize(tag);
        const compositeByteLength = getByteLength(compositeSize);
        contentWords = getListByteLength(ListElementSize.COMPOSITE, length, compositeSize) / 8;
        c.segment.setWordZero(c.byteOffset - 8);
        for (let i = 0; i < length; i++) {
          for (let j = 0; j < compositeSize.pointerLength; j++) {
            erase(
              new Pointer(
                c.segment,
                c.byteOffset + i * compositeByteLength + j * 8,
                p._capnp.depthLimit - 1
              )
            );
          }
        }
      }
      c.segment.fillZeroWords(c.byteOffset, contentWords);
      break;
    }
    case PointerType.OTHER: {
      break;
    }
    default: {
      throw new Error(
        format(PTR_INVALID_POINTER_TYPE, getTargetPointerType(p))
      );
    }
  }
  erasePointer(p);
}
function erasePointer(p) {
  if (getPointerType(p) === PointerType.FAR) {
    const landingPad = followFar(p);
    if (isDoubleFar(p)) {
      landingPad.segment.setWordZero(landingPad.byteOffset + 8);
    }
    landingPad.segment.setWordZero(landingPad.byteOffset);
  }
  p.segment.setWordZero(p.byteOffset);
}
function followFar(p) {
  const targetSegment = p.segment.message.getSegment(
    p.segment.getUint32(p.byteOffset + 4)
  );
  const targetWordOffset = p.segment.getUint32(p.byteOffset) >>> 3;
  return new Pointer(
    targetSegment,
    targetWordOffset * 8,
    p._capnp.depthLimit - 1
  );
}
function followFars(p) {
  if (getPointerType(p) === PointerType.FAR) {
    const landingPad = followFar(p);
    if (isDoubleFar(p)) {
      landingPad.byteOffset += 8;
    }
    return landingPad;
  }
  return p;
}
function getCapabilityId(p) {
  return p.segment.getUint32(p.byteOffset + 4);
}
function isCompositeList(p) {
  return getTargetPointerType(p) === PointerType.LIST && getTargetListElementSize(p) === ListElementSize.COMPOSITE;
}
function getContent(p, ignoreCompositeIndex) {
  let c;
  if (isDoubleFar(p)) {
    const landingPad = followFar(p);
    c = new Pointer(
      p.segment.message.getSegment(getFarSegmentId(landingPad)),
      getOffsetWords(landingPad) * 8
    );
  } else {
    const target = followFars(p);
    c = new Pointer(
      target.segment,
      target.byteOffset + 8 + getOffsetWords(target) * 8
    );
  }
  if (isCompositeList(p)) {
    c.byteOffset += 8;
  }
  if (!ignoreCompositeIndex && p._capnp.compositeIndex !== void 0) {
    c.byteOffset -= 8;
    c.byteOffset += 8 + p._capnp.compositeIndex * getByteLength(padToWord(getStructSize(c)));
  }
  return c;
}
function getFarSegmentId(p) {
  return p.segment.getUint32(p.byteOffset + 4);
}
function getListElementSize(p) {
  return p.segment.getUint32(p.byteOffset + 4) & LIST_SIZE_MASK;
}
function getListLength(p) {
  return p.segment.getUint32(p.byteOffset + 4) >>> 3;
}
function getOffsetWords(p) {
  const o = p.segment.getInt32(p.byteOffset);
  return o & 2 ? o >> 3 : o >> 2;
}
function getPointerType(p) {
  return p.segment.getUint32(p.byteOffset) & POINTER_TYPE_MASK;
}
function getStructDataWords(p) {
  return p.segment.getUint16(p.byteOffset + 4);
}
function getStructPointerLength(p) {
  return p.segment.getUint16(p.byteOffset + 6);
}
function getStructSize(p) {
  return new ObjectSize(getStructDataWords(p) * 8, getStructPointerLength(p));
}
function getTargetCompositeListTag(p) {
  const c = getContent(p);
  c.byteOffset -= 8;
  return c;
}
function getTargetCompositeListSize(p) {
  return getStructSize(getTargetCompositeListTag(p));
}
function getTargetListElementSize(p) {
  return getListElementSize(followFars(p));
}
function getTargetListLength(p) {
  const t = followFars(p);
  if (getListElementSize(t) === ListElementSize.COMPOSITE) {
    return getOffsetWords(getTargetCompositeListTag(p));
  }
  return getListLength(t);
}
function getTargetPointerType(p) {
  const t = getPointerType(followFars(p));
  if (t === PointerType.FAR) {
    throw new Error(format(PTR_INVALID_FAR_TARGET, p));
  }
  return t;
}
function getTargetStructSize(p) {
  return getStructSize(followFars(p));
}
function initPointer(contentSegment, contentOffset, p) {
  if (p.segment !== contentSegment) {
    if (!contentSegment.hasCapacity(8)) {
      const landingPad2 = p.segment.allocate(16);
      setFarPointer(true, landingPad2.byteOffset / 8, landingPad2.segment.id, p);
      setFarPointer(false, contentOffset / 8, contentSegment.id, landingPad2);
      landingPad2.byteOffset += 8;
      return new PointerAllocationResult(landingPad2, 0);
    }
    const landingPad = contentSegment.allocate(8);
    if (landingPad.segment.id !== contentSegment.id) {
      throw new Error(INVARIANT_UNREACHABLE_CODE);
    }
    setFarPointer(false, landingPad.byteOffset / 8, landingPad.segment.id, p);
    return new PointerAllocationResult(
      landingPad,
      (contentOffset - landingPad.byteOffset - 8) / 8
    );
  }
  return new PointerAllocationResult(p, (contentOffset - p.byteOffset - 8) / 8);
}
function isDoubleFar(p) {
  return getPointerType(p) === PointerType.FAR && (p.segment.getUint32(p.byteOffset) & POINTER_DOUBLE_FAR_MASK) !== 0;
}
function isNull(p) {
  return p.segment.isWordZero(p.byteOffset);
}
function relocateTo(dst, src) {
  const t = followFars(src);
  const lo = t.segment.getUint8(t.byteOffset) & 3;
  const hi = t.segment.getUint32(t.byteOffset + 4);
  erase(dst);
  const res = initPointer(
    t.segment,
    t.byteOffset + 8 + getOffsetWords(t) * 8,
    dst
  );
  res.pointer.segment.setUint32(
    res.pointer.byteOffset,
    lo | res.offsetWords << 2
  );
  res.pointer.segment.setUint32(res.pointer.byteOffset + 4, hi);
  erasePointer(src);
}
function setFarPointer(doubleFar, offsetWords, segmentId, p) {
  const A = PointerType.FAR;
  const B = doubleFar ? 1 : 0;
  const C = offsetWords;
  const D = segmentId;
  p.segment.setUint32(p.byteOffset, A | B << 2 | C << 3);
  p.segment.setUint32(p.byteOffset + 4, D);
}
function setInterfacePointer(capId, p) {
  p.segment.setUint32(p.byteOffset, PointerType.OTHER);
  p.segment.setUint32(p.byteOffset + 4, capId);
}
function getInterfacePointer(p) {
  return p.segment.getUint32(p.byteOffset + 4);
}
function setListPointer(offsetWords, size, length, p, compositeSize) {
  const A = PointerType.LIST;
  const B = offsetWords;
  const C = size;
  let D = length;
  if (size === ListElementSize.COMPOSITE) {
    if (compositeSize === void 0) {
      throw new TypeError(TYPE_COMPOSITE_SIZE_UNDEFINED);
    }
    D *= getWordLength(compositeSize);
  }
  p.segment.setUint32(p.byteOffset, A | B << 2);
  p.segment.setUint32(p.byteOffset + 4, C | D << 3);
}
function setStructPointer(offsetWords, size, p) {
  const A = PointerType.STRUCT;
  const B = offsetWords;
  const C = getDataWordLength(size);
  const D = size.pointerLength;
  p.segment.setUint32(p.byteOffset, A | B << 2);
  p.segment.setUint16(p.byteOffset + 4, C);
  p.segment.setUint16(p.byteOffset + 6, D);
}
function validate(pointerType, p, elementSize) {
  if (isNull(p)) {
    return;
  }
  const t = followFars(p);
  const A = t.segment.getUint32(t.byteOffset) & POINTER_TYPE_MASK;
  if (A !== pointerType) {
    throw new Error(format(PTR_WRONG_POINTER_TYPE, p, pointerType));
  }
  if (elementSize !== void 0) {
    const C = t.segment.getUint32(t.byteOffset + 4) & LIST_SIZE_MASK;
    if (C !== elementSize) {
      throw new Error(
        format(PTR_WRONG_LIST_TYPE, p, ListElementSize[elementSize])
      );
    }
  }
}
function copyFromInterface(src, dst) {
  const srcCapId = getInterfacePointer(src);
  if (srcCapId < 0) {
    return;
  }
  const srcCapTable = src.segment.message._capnp.capTable;
  if (!srcCapTable) {
    return;
  }
  const client = srcCapTable[srcCapId];
  if (!client) {
    return;
  }
  const dstCapId = dst.segment.message.addCap(client);
  setInterfacePointer(dstCapId, dst);
}
function copyFromList(src, dst) {
  if (dst._capnp.depthLimit <= 0) {
    throw new Error(PTR_DEPTH_LIMIT_EXCEEDED);
  }
  const srcContent = getContent(src);
  const srcElementSize = getTargetListElementSize(src);
  const srcLength = getTargetListLength(src);
  let srcCompositeSize;
  let srcStructByteLength;
  let dstContent;
  if (srcElementSize === ListElementSize.POINTER) {
    dstContent = dst.segment.allocate(srcLength << 3);
    for (let i = 0; i < srcLength; i++) {
      const srcPtr = new Pointer(
        srcContent.segment,
        srcContent.byteOffset + (i << 3),
        src._capnp.depthLimit - 1
      );
      const dstPtr = new Pointer(
        dstContent.segment,
        dstContent.byteOffset + (i << 3),
        dst._capnp.depthLimit - 1
      );
      copyFrom(srcPtr, dstPtr);
    }
  } else if (srcElementSize === ListElementSize.COMPOSITE) {
    srcCompositeSize = padToWord(getTargetCompositeListSize(src));
    srcStructByteLength = getByteLength(srcCompositeSize);
    dstContent = dst.segment.allocate(
      getByteLength(srcCompositeSize) * srcLength + 8
    );
    dstContent.segment.copyWord(
      dstContent.byteOffset,
      srcContent.segment,
      srcContent.byteOffset - 8
    );
    if (srcCompositeSize.dataByteLength > 0) {
      const wordLength = getWordLength(srcCompositeSize) * srcLength;
      dstContent.segment.copyWords(
        dstContent.byteOffset + 8,
        srcContent.segment,
        srcContent.byteOffset,
        wordLength
      );
    }
    for (let i = 0; i < srcLength; i++) {
      for (let j = 0; j < srcCompositeSize.pointerLength; j++) {
        const offset = i * srcStructByteLength + srcCompositeSize.dataByteLength + (j << 3);
        const srcPtr = new Pointer(
          srcContent.segment,
          srcContent.byteOffset + offset,
          src._capnp.depthLimit - 1
        );
        const dstPtr = new Pointer(
          dstContent.segment,
          dstContent.byteOffset + offset + 8,
          dst._capnp.depthLimit - 1
        );
        dstPtr.segment.setWordZero(dstPtr.byteOffset);
        copyFrom(srcPtr, dstPtr);
      }
    }
  } else {
    const byteLength = padToWord$1(
      srcElementSize === ListElementSize.BIT ? srcLength + 7 >>> 3 : getListElementByteLength(srcElementSize) * srcLength
    );
    const wordLength = byteLength >>> 3;
    dstContent = dst.segment.allocate(byteLength);
    dstContent.segment.copyWords(
      dstContent.byteOffset,
      srcContent.segment,
      srcContent.byteOffset,
      wordLength
    );
  }
  const res = initPointer(dstContent.segment, dstContent.byteOffset, dst);
  setListPointer(
    res.offsetWords,
    srcElementSize,
    srcLength,
    res.pointer,
    srcCompositeSize
  );
}
function copyFromStruct(src, dst) {
  if (dst._capnp.depthLimit <= 0) {
    throw new Error(PTR_DEPTH_LIMIT_EXCEEDED);
  }
  const srcContent = getContent(src);
  const srcSize = getTargetStructSize(src);
  const srcDataWordLength = getDataWordLength(srcSize);
  const dstContent = dst.segment.allocate(getByteLength(srcSize));
  dstContent.segment.copyWords(
    dstContent.byteOffset,
    srcContent.segment,
    srcContent.byteOffset,
    srcDataWordLength
  );
  for (let i = 0; i < srcSize.pointerLength; i++) {
    const offset = srcSize.dataByteLength + i * 8;
    const srcPtr = new Pointer(
      srcContent.segment,
      srcContent.byteOffset + offset,
      src._capnp.depthLimit - 1
    );
    const dstPtr = new Pointer(
      dstContent.segment,
      dstContent.byteOffset + offset,
      dst._capnp.depthLimit - 1
    );
    copyFrom(srcPtr, dstPtr);
  }
  if (dst._capnp.compositeList) {
    return;
  }
  const res = initPointer(dstContent.segment, dstContent.byteOffset, dst);
  setStructPointer(res.offsetWords, srcSize, res.pointer);
}
function trackPointerAllocation(message, p) {
  message._capnp.traversalLimit -= 8;
  if (message._capnp.traversalLimit <= 0) {
    throw new Error(format(PTR_TRAVERSAL_LIMIT_EXCEEDED, p));
  }
}
class PointerAllocationResult {
  constructor(pointer, offsetWords) {
    this.pointer = pointer;
    this.offsetWords = offsetWords;
  }
}

var PointerType = /* @__PURE__ */ ((PointerType2) => {
  PointerType2[PointerType2["STRUCT"] = 0] = "STRUCT";
  PointerType2[PointerType2["LIST"] = 1] = "LIST";
  PointerType2[PointerType2["FAR"] = 2] = "FAR";
  PointerType2[PointerType2["OTHER"] = 3] = "OTHER";
  return PointerType2;
})(PointerType || {});
class Pointer {
  static _capnp = {
    displayName: "Pointer"
  };
  _capnp;
  /** Offset, in bytes, from the start of the segment to the beginning of this pointer. */
  byteOffset;
  /**
   * The starting segment for this pointer's data. In the case of a far pointer, the actual content this pointer is
   * referencing will be in another segment within the same message.
   */
  segment;
  constructor(segment, byteOffset, depthLimit = MAX_DEPTH) {
    this._capnp = { compositeList: false, depthLimit };
    this.segment = segment;
    this.byteOffset = byteOffset;
    if (depthLimit < 1) {
      throw new Error(format(PTR_DEPTH_LIMIT_EXCEEDED, this));
    }
    trackPointerAllocation(segment.message, this);
    if (byteOffset < 0 || byteOffset > segment.byteLength) {
      throw new Error(format(PTR_OFFSET_OUT_OF_BOUNDS, byteOffset));
    }
  }
  [Symbol.toStringTag]() {
    return format("Pointer_%d", this.segment.id);
  }
  toString() {
    return format("->%d@%a%s", this.segment.id, this.byteOffset, dump(this));
  }
}

class Struct extends Pointer {
  static _capnp = {
    displayName: "Struct"
  };
  /**
   * Create a new pointer to a struct.
   *
   * @param segment The segment the pointer resides in.
   * @param byteOffset The offset from the beginning of the segment to the beginning of the pointer data.
   * @param depthLimit The nesting depth limit for this object.
   * @param compositeIndex If set, then this pointer is actually a reference to a composite list
   * (`this._getPointerTargetType() === PointerType.LIST`), and this number is used as the index of the struct within
   * the list. It is not valid to call `initStruct()` on a composite struct – the struct contents are initialized when
   * the list pointer is initialized.
   */
  constructor(segment, byteOffset, depthLimit = MAX_DEPTH, compositeIndex) {
    super(segment, byteOffset, depthLimit);
    this._capnp.compositeIndex = compositeIndex;
    this._capnp.compositeList = compositeIndex !== void 0;
  }
  static [Symbol.toStringTag]() {
    return this._capnp.displayName;
  }
  [Symbol.toStringTag]() {
    return `Struct_${super.toString()}${this._capnp.compositeIndex === void 0 ? "" : `,ci:${this._capnp.compositeIndex}`} > ${getContent(this).toString()}`;
  }
}
class AnyStruct extends Struct {
  static _capnp = {
    displayName: "AnyStruct",
    id: "0",
    typeId: 0n,
    typeIdHex: "0",
    size: new ObjectSize(0, 0),
    fields: []
  };
}

export { dumpBuffer as $, getTargetPointerType as A, getTargetListElementSize as B, PTR_STRUCT_DATA_OUT_OF_BOUNDS as C, PTR_STRUCT_POINTER_OUT_OF_BOUNDS as D, PTR_INIT_COMPOSITE_STRUCT as E, getDataWordLength as F, getStructSize as G, getInterfacePointer as H, PTR_INVALID_UNION_ACCESS as I, SEG_NOT_WORD_ALIGNED as J, DEFAULT_BUFFER_SIZE as K, ListElementSize as L, SEG_ID_OUT_OF_BOUNDS as M, NATIVE_LITTLE_ENDIAN as N, ObjectSize as O, PTR_INVALID_LIST_SIZE as P, SEG_GET_NON_ZERO_SINGLE as Q, RPC_METHOD_NOT_IMPLEMENTED as R, Struct as S, MIN_SINGLE_SEGMENT_GROWTH as T, assertNever as U, MSG_PACK_NOT_WORD_ALIGNED as V, PACK_SPAN_THRESHOLD as W, MAX_SEGMENT_LENGTH as X, SEG_SIZE_OVERFLOW as Y, SEG_REPLACEMENT_BUFFER_TOO_SMALL as Z, MSG_SEGMENT_OUT_OF_BOUNDS as _, adopt as a, MSG_SEGMENT_TOO_SMALL as a0, DEFAULT_TRAVERSE_LIMIT as a1, MSG_INVALID_FRAME_HEADER as a2, MAX_DEPTH as a3, RPC_ERROR as a4, RPC_CALL_QUEUE_FULL as a5, INVARIANT_UNREACHABLE_CODE as a6, RPC_QUEUE_CALL_CANCEL as a7, RPC_METHOD_ERROR as a8, RPC_ZERO_REF as a9, getOffsetWords as aA, getPointerType as aB, getStructDataWords as aC, getStructPointerLength as aD, getTargetCompositeListTag as aE, isDoubleFar as aF, relocateTo as aG, setFarPointer as aH, trackPointerAllocation as aI, Orphan as aJ, RPC_FULFILL_ALREADY_CALLED as aa, RPC_IMPORT_CLOSED as ab, AnyStruct as ac, RPC_QUESTION_ID_REUSED as ad, RPC_NO_MAIN_INTERFACE as ae, setInterfacePointer as af, RPC_UNIMPLEMENTED as ag, RPC_RETURN_FOR_UNKNOWN_QUESTION as ah, RPC_BAD_TARGET as ai, RPC_UNKNOWN_CAP_DESCRIPTOR as aj, RPC_UNKNOWN_ANSWER_ID as ak, RPC_UNKNOWN_EXPORT_ID as al, pad as am, PointerAllocationResult as an, add as ao, copyFromInterface as ap, copyFromList as aq, copyFromStruct as ar, dump as as, erasePointer as at, followFar as au, getCapabilityId as av, getFarSegmentId as aw, getListByteLength as ax, getListElementSize as ay, getListLength as az, PTR_COMPOSITE_SIZE_UNDEFINED as b, copyFrom as c, disown as d, padToWord as e, format as f, getByteLength as g, setStructPointer as h, isNull as i, getListElementByteLength as j, initPointer as k, Pointer as l, getTargetListLength as m, LIST_NO_SEARCH as n, LIST_NO_MUTABLE as o, padToWord$1 as p, PointerType as q, getContent as r, setListPointer as s, erase as t, RPC_NULL_CLIENT as u, validate as v, getTargetStructSize as w, getTargetCompositeListSize as x, getWordLength as y, followFars as z };
