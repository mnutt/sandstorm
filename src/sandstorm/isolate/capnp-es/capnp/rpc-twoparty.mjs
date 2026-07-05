import { S as Struct, O as ObjectSize, a as adopt, d as disown, i as isNull, c as copyFrom } from '../shared/capnp-es.Da9bkTPj.mjs';
import { a as getUint16, s as setUint16, b as getUint32, c as setUint32, d as getBit, e as setBit, g as getPointer } from '../shared/capnp-es.iydqJhtG.mjs';

const _capnpFileId = 0xa184c7885cdaf2a1n;
const Side = {
  /**
  * The object lives on the "server" or "supervisor" end of the connection. Only the
  * server/supervisor knows how to interpret the ref; to the client, it is opaque.
  *
  * Note that containers intending to implement strong confinement should rewrite SturdyRefs
  * received from the external network before passing them on to the confined app. The confined
  * app thus does not ever receive the raw bits of the SturdyRef (which it could perhaps
  * maliciously leak), but instead receives only a thing that it can pass back to the container
  * later to restore the ref. See:
  * http://www.erights.org/elib/capability/dist-confine.html
  *
  */
  SERVER: 0,
  /**
  * The object lives on the "client" or "confined app" end of the connection. Only the client
  * knows how to interpret the ref; to the server/supervisor, it is opaque. Most clients do not
  * actually know how to persist capabilities at all, so use of this is unusual.
  *
  */
  CLIENT: 1
};
class VatId extends Struct {
  static _capnp = {
    displayName: "VatId",
    id: "d20b909fee733a8e",
    typeId: 0xd20b909fee733a8en,
    typeIdHex: "d20b909fee733a8e",
    size: new ObjectSize(8, 0),
    fields: [
      { name: "side", codeOrder: 0, ordinal: 0, kind: "slot", offset: 0, type: { kind: "enum", typeId: 0x9fd69ebc87b9719cn, typeIdHex: "9fd69ebc87b9719c", displayName: "Side" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["side"];
      if (value2 !== void 0) {
        target.side = value2;
      }
    }
  }
  get side() {
    return getUint16(0, this);
  }
  set side(value) {
    setUint16(0, value, this);
  }
  toString() {
    return "VatId_" + super.toString();
  }
}
class ProvisionId extends Struct {
  static _capnp = {
    displayName: "ProvisionId",
    id: "b88d09a9c5f39817",
    typeId: 0xb88d09a9c5f39817n,
    typeIdHex: "b88d09a9c5f39817",
    size: new ObjectSize(8, 0),
    fields: [
      { name: "joinId", codeOrder: 0, ordinal: 0, kind: "slot", offset: 0, type: { kind: "uint32" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["joinId"];
      if (value2 !== void 0) {
        target.joinId = value2;
      }
    }
  }
  /**
  * The ID from `JoinKeyPart`.
  *
  */
  get joinId() {
    return getUint32(0, this);
  }
  set joinId(value) {
    setUint32(0, value, this);
  }
  toString() {
    return "ProvisionId_" + super.toString();
  }
}
class RecipientId extends Struct {
  static _capnp = {
    displayName: "RecipientId",
    id: "89f389b6fd4082c1",
    typeId: 0x89f389b6fd4082c1n,
    typeIdHex: "89f389b6fd4082c1",
    size: new ObjectSize(0, 0),
    fields: []
  };
  static _applyInit(target, value) {
  }
  toString() {
    return "RecipientId_" + super.toString();
  }
}
class ThirdPartyCapId extends Struct {
  static _capnp = {
    displayName: "ThirdPartyCapId",
    id: "b47f4979672cb59d",
    typeId: 0xb47f4979672cb59dn,
    typeIdHex: "b47f4979672cb59d",
    size: new ObjectSize(0, 0),
    fields: []
  };
  static _applyInit(target, value) {
  }
  toString() {
    return "ThirdPartyCapId_" + super.toString();
  }
}
class JoinKeyPart extends Struct {
  static _capnp = {
    displayName: "JoinKeyPart",
    id: "95b29059097fca83",
    typeId: 0x95b29059097fca83n,
    typeIdHex: "95b29059097fca83",
    size: new ObjectSize(8, 0),
    fields: [
      { name: "joinId", codeOrder: 0, ordinal: 0, kind: "slot", offset: 0, type: { kind: "uint32" } },
      { name: "partCount", codeOrder: 1, ordinal: 1, kind: "slot", offset: 2, type: { kind: "uint16" } },
      { name: "partNum", codeOrder: 2, ordinal: 2, kind: "slot", offset: 3, type: { kind: "uint16" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["joinId"];
      if (value2 !== void 0) {
        target.joinId = value2;
      }
    }
    {
      const value2 = init["partCount"];
      if (value2 !== void 0) {
        target.partCount = value2;
      }
    }
    {
      const value2 = init["partNum"];
      if (value2 !== void 0) {
        target.partNum = value2;
      }
    }
  }
  /**
  * A number identifying this join, chosen by the sender.  May be reused once `Finish` messages are
  * sent corresponding to all of the `Join` messages.
  *
  */
  get joinId() {
    return getUint32(0, this);
  }
  set joinId(value) {
    setUint32(0, value, this);
  }
  /**
  * The number of capabilities to be joined.
  *
  */
  get partCount() {
    return getUint16(4, this);
  }
  set partCount(value) {
    setUint16(4, value, this);
  }
  /**
  * Which part this request targets -- a number in the range [0, partCount).
  *
  */
  get partNum() {
    return getUint16(6, this);
  }
  set partNum(value) {
    setUint16(6, value, this);
  }
  toString() {
    return "JoinKeyPart_" + super.toString();
  }
}
class JoinResult extends Struct {
  static _capnp = {
    displayName: "JoinResult",
    id: "9d263a3630b7ebee",
    typeId: 0x9d263a3630b7ebeen,
    typeIdHex: "9d263a3630b7ebee",
    size: new ObjectSize(8, 1),
    fields: [
      { name: "joinId", codeOrder: 0, ordinal: 0, kind: "slot", offset: 0, type: { kind: "uint32" } },
      { name: "succeeded", codeOrder: 1, ordinal: 1, kind: "slot", offset: 32, type: { kind: "bool" } },
      { name: "cap", codeOrder: 2, ordinal: 2, kind: "slot", offset: 0, type: { kind: "anyPointer" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["joinId"];
      if (value2 !== void 0) {
        target.joinId = value2;
      }
    }
    {
      const value2 = init["succeeded"];
      if (value2 !== void 0) {
        target.succeeded = value2;
      }
    }
    {
      const value2 = init["cap"];
      if (value2 !== void 0) {
        target.cap = value2;
      }
    }
  }
  /**
  * Matches `JoinKeyPart`.
  *
  */
  get joinId() {
    return getUint32(0, this);
  }
  set joinId(value) {
    setUint32(0, value, this);
  }
  /**
  * All JoinResults in the set will have the same value for `succeeded`.  The receiver actually
  * implements the join by waiting for all the `JoinKeyParts` and then performing its own join on
  * them, then going back and answering all the join requests afterwards.
  *
  */
  get succeeded() {
    return getBit(32, this);
  }
  set succeeded(value) {
    setBit(32, value, this);
  }
  _adoptCap(value) {
    adopt(value, getPointer(0, this));
  }
  _disownCap() {
    return disown(this.cap);
  }
  /**
  * One of the JoinResults will have a non-null `cap` which is the joined capability.
  *
  */
  get cap() {
    return getPointer(0, this);
  }
  _hasCap() {
    return !isNull(getPointer(0, this));
  }
  set cap(value) {
    copyFrom(value, getPointer(0, this));
  }
  toString() {
    return "JoinResult_" + super.toString();
  }
}

export { JoinKeyPart, JoinResult, ProvisionId, RecipientId, Side, ThirdPartyCapId, VatId, _capnpFileId };
