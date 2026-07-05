import { S as Struct, O as ObjectSize, a as adopt, d as disown, i as isNull, c as copyFrom } from '../shared/capnp-es.Da9bkTPj.mjs';
import { b as getUint16Mask, C as CompositeList } from '../shared/capnp-es.CKgVaTmi.mjs';
import { L as List, p as getText, q as setText, a as getUint16, s as setUint16, g as getPointer, l as getList, m as initList, t as testWhich, k as getAs, h as getUint64, j as setUint64, f as getStruct, i as initStructAt, b as getUint32, c as setUint32, d as getBit, e as setBit, D as Data, r as getInt8, u as setInt8, v as getInt16, w as setInt16, x as getInt32, y as setInt32, z as getInt64, A as setInt64, n as getUint8, o as setUint8, B as getFloat32, C as setFloat32, F as getFloat64, G as setFloat64, H as getData, I as initData } from '../shared/capnp-es.iydqJhtG.mjs';
import { d as dataBytes } from '../shared/capnp-es.jIzw5uss.mjs';

const _capnpFileId = 0xa93fc509624c72d9n;
class Node_Parameter extends Struct {
  static _capnp = {
    displayName: "Parameter",
    id: "b9521bccf10fa3b1",
    typeId: 0xb9521bccf10fa3b1n,
    typeIdHex: "b9521bccf10fa3b1",
    size: new ObjectSize(0, 1),
    fields: [
      { name: "name", codeOrder: 0, ordinal: 0, kind: "slot", offset: 0, type: { kind: "text" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["name"];
      if (value2 !== void 0) {
        target.name = value2;
      }
    }
  }
  get name() {
    return getText(0, this);
  }
  set name(value) {
    setText(0, value, this);
  }
  toString() {
    return "Node_Parameter_" + super.toString();
  }
}
class Node_NestedNode extends Struct {
  static _capnp = {
    displayName: "NestedNode",
    id: "debf55bbfa0fc242",
    typeId: 0xdebf55bbfa0fc242n,
    typeIdHex: "debf55bbfa0fc242",
    size: new ObjectSize(8, 1),
    fields: [
      { name: "name", codeOrder: 0, ordinal: 0, kind: "slot", offset: 0, type: { kind: "text" } },
      { name: "id", codeOrder: 1, ordinal: 1, kind: "slot", offset: 0, type: { kind: "uint64" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["name"];
      if (value2 !== void 0) {
        target.name = value2;
      }
    }
    {
      const value2 = init["id"];
      if (value2 !== void 0) {
        target.id = value2;
      }
    }
  }
  /**
  * Unqualified symbol name.  Unlike Node.displayName, this *can* be used programmatically.
  *
  * (On Zooko's triangle, this is the node's petname according to its parent scope.)
  *
  */
  get name() {
    return getText(0, this);
  }
  set name(value) {
    setText(0, value, this);
  }
  /**
  * ID of the nested node.  Typically, the target node's scopeId points back to this node, but
  * robust code should avoid relying on this.
  *
  */
  get id() {
    return getUint64(0, this);
  }
  set id(value) {
    setUint64(0, value, this);
  }
  toString() {
    return "Node_NestedNode_" + super.toString();
  }
}
class Node_SourceInfo_Member extends Struct {
  static _capnp = {
    displayName: "Member",
    id: "c2ba9038898e1fa2",
    typeId: 0xc2ba9038898e1fa2n,
    typeIdHex: "c2ba9038898e1fa2",
    size: new ObjectSize(0, 1),
    fields: [
      { name: "docComment", codeOrder: 0, ordinal: 0, kind: "slot", offset: 0, type: { kind: "text" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["docComment"];
      if (value2 !== void 0) {
        target.docComment = value2;
      }
    }
  }
  /**
  * Doc comment on the member.
  *
  */
  get docComment() {
    return getText(0, this);
  }
  set docComment(value) {
    setText(0, value, this);
  }
  toString() {
    return "Node_SourceInfo_Member_" + super.toString();
  }
}
class Node_SourceInfo extends Struct {
  static Member = Node_SourceInfo_Member;
  static _capnp = {
    displayName: "SourceInfo",
    id: "f38e1de3041357ae",
    typeId: 0xf38e1de3041357aen,
    typeIdHex: "f38e1de3041357ae",
    size: new ObjectSize(8, 2),
    fields: [
      { name: "id", codeOrder: 0, ordinal: 0, kind: "slot", offset: 0, type: { kind: "uint64" } },
      { name: "docComment", codeOrder: 1, ordinal: 1, kind: "slot", offset: 0, type: { kind: "text" } },
      { name: "members", codeOrder: 2, ordinal: 2, kind: "slot", offset: 1, type: { kind: "list", elementType: { kind: "struct", typeId: 0xc2ba9038898e1fa2n, typeIdHex: "c2ba9038898e1fa2", displayName: "Member" } } }
    ]
  };
  static _Members;
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["id"];
      if (value2 !== void 0) {
        target.id = value2;
      }
    }
    {
      const value2 = init["docComment"];
      if (value2 !== void 0) {
        target.docComment = value2;
      }
    }
    {
      const value2 = init["members"];
      if (value2 !== void 0) {
        if (value2 instanceof List) {
          target.members = value2;
        } else {
          const values = Array.isArray(value2) ? value2 : Array.from(value2);
          const list = target._initMembers(values.length);
          for (let index = 0; index < values.length; index++) {
            const item = values[index];
            if (item instanceof Node_SourceInfo_Member) {
              list.set(index, item);
            } else {
              Node_SourceInfo_Member._applyInit(list.get(index), item);
            }
          }
        }
      }
    }
  }
  /**
  * ID of the Node which this info describes.
  *
  */
  get id() {
    return getUint64(0, this);
  }
  set id(value) {
    setUint64(0, value, this);
  }
  /**
  * The top-level doc comment for the Node.
  *
  */
  get docComment() {
    return getText(0, this);
  }
  set docComment(value) {
    setText(0, value, this);
  }
  _adoptMembers(value) {
    adopt(value, getPointer(1, this));
  }
  _disownMembers() {
    return disown(this.members);
  }
  /**
  * Information about each member -- i.e. fields (for structs), enumerants (for enums), or
  * methods (for interfaces).
  *
  * This list is the same length and order as the corresponding list in the Node, i.e.
  * Node.struct.fields, Node.enum.enumerants, or Node.interface.methods.
  *
  */
  get members() {
    return getList(1, Node_SourceInfo._Members, this);
  }
  _hasMembers() {
    return !isNull(getPointer(1, this));
  }
  _initMembers(length) {
    return initList(1, Node_SourceInfo._Members, length, this);
  }
  set members(value) {
    copyFrom(value, getPointer(1, this));
  }
  toString() {
    return "Node_SourceInfo_" + super.toString();
  }
}
class Node_Struct extends Struct {
  static _capnp = {
    displayName: "struct",
    id: "9ea0b19b37fb4435",
    typeId: 0x9ea0b19b37fb4435n,
    typeIdHex: "9ea0b19b37fb4435",
    size: new ObjectSize(40, 6),
    fields: [
      { name: "dataWordCount", codeOrder: 0, ordinal: 7, kind: "slot", offset: 7, type: { kind: "uint16" } },
      { name: "pointerCount", codeOrder: 1, ordinal: 8, kind: "slot", offset: 12, type: { kind: "uint16" } },
      { name: "preferredListEncoding", codeOrder: 2, ordinal: 9, kind: "slot", offset: 13, type: { kind: "enum", typeId: 0xd1958f7dba521926n, typeIdHex: "d1958f7dba521926", displayName: "ElementSize" } },
      { name: "isGroup", codeOrder: 3, ordinal: 10, kind: "slot", offset: 224, type: { kind: "bool" } },
      { name: "discriminantCount", codeOrder: 4, ordinal: 11, kind: "slot", offset: 15, type: { kind: "uint16" } },
      { name: "discriminantOffset", codeOrder: 5, ordinal: 12, kind: "slot", offset: 8, type: { kind: "uint32" } },
      { name: "fields", codeOrder: 6, ordinal: 13, kind: "slot", offset: 3, type: { kind: "list", elementType: { kind: "struct", typeId: 0x9aad50a41f4af45fn, typeIdHex: "9aad50a41f4af45f", displayName: "Field" } } }
    ]
  };
  static _Fields;
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["dataWordCount"];
      if (value2 !== void 0) {
        target.dataWordCount = value2;
      }
    }
    {
      const value2 = init["pointerCount"];
      if (value2 !== void 0) {
        target.pointerCount = value2;
      }
    }
    {
      const value2 = init["preferredListEncoding"];
      if (value2 !== void 0) {
        target.preferredListEncoding = value2;
      }
    }
    {
      const value2 = init["isGroup"];
      if (value2 !== void 0) {
        target.isGroup = value2;
      }
    }
    {
      const value2 = init["discriminantCount"];
      if (value2 !== void 0) {
        target.discriminantCount = value2;
      }
    }
    {
      const value2 = init["discriminantOffset"];
      if (value2 !== void 0) {
        target.discriminantOffset = value2;
      }
    }
    {
      const value2 = init["fields"];
      if (value2 !== void 0) {
        if (value2 instanceof List) {
          target.fields = value2;
        } else {
          const values = Array.isArray(value2) ? value2 : Array.from(value2);
          const list = target._initFields(values.length);
          for (let index = 0; index < values.length; index++) {
            const item = values[index];
            if (item instanceof Field) {
              list.set(index, item);
            } else {
              Field._applyInit(list.get(index), item);
            }
          }
        }
      }
    }
  }
  /**
  * Size of the data section, in words.
  *
  */
  get dataWordCount() {
    return getUint16(14, this);
  }
  set dataWordCount(value) {
    setUint16(14, value, this);
  }
  /**
  * Size of the pointer section, in pointers (which are one word each).
  *
  */
  get pointerCount() {
    return getUint16(24, this);
  }
  set pointerCount(value) {
    setUint16(24, value, this);
  }
  /**
  * The preferred element size to use when encoding a list of this struct.  If this is anything
  * other than `inlineComposite` then the struct is one word or less in size and is a candidate
  * for list packing optimization.
  *
  */
  get preferredListEncoding() {
    return getUint16(26, this);
  }
  set preferredListEncoding(value) {
    setUint16(26, value, this);
  }
  /**
  * If true, then this "struct" node is actually not an independent node, but merely represents
  * some named union or group within a particular parent struct.  This node's scopeId refers
  * to the parent struct, which may itself be a union/group in yet another struct.
  *
  * All group nodes share the same dataWordCount and pointerCount as the top-level
  * struct, and their fields live in the same ordinal and offset spaces as all other fields in
  * the struct.
  *
  * Note that a named union is considered a special kind of group -- in fact, a named union
  * is exactly equivalent to a group that contains nothing but an unnamed union.
  *
  */
  get isGroup() {
    return getBit(224, this);
  }
  set isGroup(value) {
    setBit(224, value, this);
  }
  /**
  * Number of fields in this struct which are members of an anonymous union, and thus may
  * overlap.  If this is non-zero, then a 16-bit discriminant is present indicating which
  * of the overlapping fields is active.  This can never be 1 -- if it is non-zero, it must be
  * two or more.
  *
  * Note that the fields of an unnamed union are considered fields of the scope containing the
  * union -- an unnamed union is not its own group.  So, a top-level struct may contain a
  * non-zero discriminant count.  Named unions, on the other hand, are equivalent to groups
  * containing unnamed unions.  So, a named union has its own independent schema node, with
  * `isGroup` = true.
  *
  */
  get discriminantCount() {
    return getUint16(30, this);
  }
  set discriminantCount(value) {
    setUint16(30, value, this);
  }
  /**
  * If `discriminantCount` is non-zero, this is the offset of the union discriminant, in
  * multiples of 16 bits.
  *
  */
  get discriminantOffset() {
    return getUint32(32, this);
  }
  set discriminantOffset(value) {
    setUint32(32, value, this);
  }
  _adoptFields(value) {
    adopt(value, getPointer(3, this));
  }
  _disownFields() {
    return disown(this.fields);
  }
  /**
  * Fields defined within this scope (either the struct's top-level fields, or the fields of
  * a particular group; see `isGroup`).
  *
  * The fields are sorted by ordinal number, but note that because groups share the same
  * ordinal space, the field's index in this list is not necessarily exactly its ordinal.
  * On the other hand, the field's position in this list does remain the same even as the
  * protocol evolves, since it is not possible to insert or remove an earlier ordinal.
  * Therefore, for most use cases, if you want to identify a field by number, it may make the
  * most sense to use the field's index in this list rather than its ordinal.
  *
  */
  get fields() {
    return getList(3, Node_Struct._Fields, this);
  }
  _hasFields() {
    return !isNull(getPointer(3, this));
  }
  _initFields(length) {
    return initList(3, Node_Struct._Fields, length, this);
  }
  set fields(value) {
    copyFrom(value, getPointer(3, this));
  }
  toString() {
    return "Node_Struct_" + super.toString();
  }
}
class Node_Enum extends Struct {
  static _capnp = {
    displayName: "enum",
    id: "b54ab3364333f598",
    typeId: 0xb54ab3364333f598n,
    typeIdHex: "b54ab3364333f598",
    size: new ObjectSize(40, 6),
    fields: [
      { name: "enumerants", codeOrder: 0, ordinal: 14, kind: "slot", offset: 3, type: { kind: "list", elementType: { kind: "struct", typeId: 0x978a7cebdc549a4dn, typeIdHex: "978a7cebdc549a4d", displayName: "Enumerant" } } }
    ]
  };
  static _Enumerants;
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["enumerants"];
      if (value2 !== void 0) {
        if (value2 instanceof List) {
          target.enumerants = value2;
        } else {
          const values = Array.isArray(value2) ? value2 : Array.from(value2);
          const list = target._initEnumerants(values.length);
          for (let index = 0; index < values.length; index++) {
            const item = values[index];
            if (item instanceof Enumerant) {
              list.set(index, item);
            } else {
              Enumerant._applyInit(list.get(index), item);
            }
          }
        }
      }
    }
  }
  _adoptEnumerants(value) {
    adopt(value, getPointer(3, this));
  }
  _disownEnumerants() {
    return disown(this.enumerants);
  }
  /**
  * Enumerants ordered by numeric value (ordinal).
  *
  */
  get enumerants() {
    return getList(3, Node_Enum._Enumerants, this);
  }
  _hasEnumerants() {
    return !isNull(getPointer(3, this));
  }
  _initEnumerants(length) {
    return initList(3, Node_Enum._Enumerants, length, this);
  }
  set enumerants(value) {
    copyFrom(value, getPointer(3, this));
  }
  toString() {
    return "Node_Enum_" + super.toString();
  }
}
class Node_Interface extends Struct {
  static _capnp = {
    displayName: "interface",
    id: "e82753cff0c2218f",
    typeId: 0xe82753cff0c2218fn,
    typeIdHex: "e82753cff0c2218f",
    size: new ObjectSize(40, 6),
    fields: [
      { name: "methods", codeOrder: 0, ordinal: 15, kind: "slot", offset: 3, type: { kind: "list", elementType: { kind: "struct", typeId: 0x9500cce23b334d80n, typeIdHex: "9500cce23b334d80", displayName: "Method" } } },
      { name: "superclasses", codeOrder: 1, ordinal: 31, kind: "slot", offset: 4, type: { kind: "list", elementType: { kind: "struct", typeId: 0xa9962a9ed0a4d7f8n, typeIdHex: "a9962a9ed0a4d7f8", displayName: "Superclass" } } }
    ]
  };
  static _Methods;
  static _Superclasses;
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["methods"];
      if (value2 !== void 0) {
        if (value2 instanceof List) {
          target.methods = value2;
        } else {
          const values = Array.isArray(value2) ? value2 : Array.from(value2);
          const list = target._initMethods(values.length);
          for (let index = 0; index < values.length; index++) {
            const item = values[index];
            if (item instanceof Method) {
              list.set(index, item);
            } else {
              Method._applyInit(list.get(index), item);
            }
          }
        }
      }
    }
    {
      const value2 = init["superclasses"];
      if (value2 !== void 0) {
        if (value2 instanceof List) {
          target.superclasses = value2;
        } else {
          const values = Array.isArray(value2) ? value2 : Array.from(value2);
          const list = target._initSuperclasses(values.length);
          for (let index = 0; index < values.length; index++) {
            const item = values[index];
            if (item instanceof Superclass) {
              list.set(index, item);
            } else {
              Superclass._applyInit(list.get(index), item);
            }
          }
        }
      }
    }
  }
  _adoptMethods(value) {
    adopt(value, getPointer(3, this));
  }
  _disownMethods() {
    return disown(this.methods);
  }
  /**
  * Methods ordered by ordinal.
  *
  */
  get methods() {
    return getList(3, Node_Interface._Methods, this);
  }
  _hasMethods() {
    return !isNull(getPointer(3, this));
  }
  _initMethods(length) {
    return initList(3, Node_Interface._Methods, length, this);
  }
  set methods(value) {
    copyFrom(value, getPointer(3, this));
  }
  _adoptSuperclasses(value) {
    adopt(value, getPointer(4, this));
  }
  _disownSuperclasses() {
    return disown(this.superclasses);
  }
  /**
  * Superclasses of this interface.
  *
  */
  get superclasses() {
    return getList(4, Node_Interface._Superclasses, this);
  }
  _hasSuperclasses() {
    return !isNull(getPointer(4, this));
  }
  _initSuperclasses(length) {
    return initList(4, Node_Interface._Superclasses, length, this);
  }
  set superclasses(value) {
    copyFrom(value, getPointer(4, this));
  }
  toString() {
    return "Node_Interface_" + super.toString();
  }
}
class Node_Const extends Struct {
  static _capnp = {
    displayName: "const",
    id: "b18aa5ac7a0d9420",
    typeId: 0xb18aa5ac7a0d9420n,
    typeIdHex: "b18aa5ac7a0d9420",
    size: new ObjectSize(40, 6),
    fields: [
      { name: "type", codeOrder: 0, ordinal: 16, kind: "slot", offset: 3, type: { kind: "struct", typeId: 0xd07378ede1f9cc60n, typeIdHex: "d07378ede1f9cc60", displayName: "Type" } },
      { name: "value", codeOrder: 1, ordinal: 17, kind: "slot", offset: 4, type: { kind: "struct", typeId: 0xce23dcd2d7b00c9bn, typeIdHex: "ce23dcd2d7b00c9b", displayName: "Value" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["type"];
      if (value2 !== void 0) {
        if (value2 instanceof Type) {
          target.type = value2;
        } else {
          Type._applyInit(target._initType(), value2);
        }
      }
    }
    {
      const value2 = init["value"];
      if (value2 !== void 0) {
        if (value2 instanceof Value) {
          target.value = value2;
        } else {
          Value._applyInit(target._initValue(), value2);
        }
      }
    }
  }
  _adoptType(value) {
    adopt(value, getPointer(3, this));
  }
  _disownType() {
    return disown(this.type);
  }
  get type() {
    return getStruct(3, Type, this);
  }
  _hasType() {
    return !isNull(getPointer(3, this));
  }
  _initType() {
    return initStructAt(3, Type, this);
  }
  set type(value) {
    copyFrom(value, getPointer(3, this));
  }
  _adoptValue(value) {
    adopt(value, getPointer(4, this));
  }
  _disownValue() {
    return disown(this.value);
  }
  get value() {
    return getStruct(4, Value, this);
  }
  _hasValue() {
    return !isNull(getPointer(4, this));
  }
  _initValue() {
    return initStructAt(4, Value, this);
  }
  set value(value) {
    copyFrom(value, getPointer(4, this));
  }
  toString() {
    return "Node_Const_" + super.toString();
  }
}
class Node_Annotation extends Struct {
  static _capnp = {
    displayName: "annotation",
    id: "ec1619d4400a0290",
    typeId: 0xec1619d4400a0290n,
    typeIdHex: "ec1619d4400a0290",
    size: new ObjectSize(40, 6),
    fields: [
      { name: "type", codeOrder: 0, ordinal: 18, kind: "slot", offset: 3, type: { kind: "struct", typeId: 0xd07378ede1f9cc60n, typeIdHex: "d07378ede1f9cc60", displayName: "Type" } },
      { name: "targetsFile", codeOrder: 1, ordinal: 19, kind: "slot", offset: 112, type: { kind: "bool" } },
      { name: "targetsConst", codeOrder: 2, ordinal: 20, kind: "slot", offset: 113, type: { kind: "bool" } },
      { name: "targetsEnum", codeOrder: 3, ordinal: 21, kind: "slot", offset: 114, type: { kind: "bool" } },
      { name: "targetsEnumerant", codeOrder: 4, ordinal: 22, kind: "slot", offset: 115, type: { kind: "bool" } },
      { name: "targetsStruct", codeOrder: 5, ordinal: 23, kind: "slot", offset: 116, type: { kind: "bool" } },
      { name: "targetsField", codeOrder: 6, ordinal: 24, kind: "slot", offset: 117, type: { kind: "bool" } },
      { name: "targetsUnion", codeOrder: 7, ordinal: 25, kind: "slot", offset: 118, type: { kind: "bool" } },
      { name: "targetsGroup", codeOrder: 8, ordinal: 26, kind: "slot", offset: 119, type: { kind: "bool" } },
      { name: "targetsInterface", codeOrder: 9, ordinal: 27, kind: "slot", offset: 120, type: { kind: "bool" } },
      { name: "targetsMethod", codeOrder: 10, ordinal: 28, kind: "slot", offset: 121, type: { kind: "bool" } },
      { name: "targetsParam", codeOrder: 11, ordinal: 29, kind: "slot", offset: 122, type: { kind: "bool" } },
      { name: "targetsAnnotation", codeOrder: 12, ordinal: 30, kind: "slot", offset: 123, type: { kind: "bool" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["type"];
      if (value2 !== void 0) {
        if (value2 instanceof Type) {
          target.type = value2;
        } else {
          Type._applyInit(target._initType(), value2);
        }
      }
    }
    {
      const value2 = init["targetsFile"];
      if (value2 !== void 0) {
        target.targetsFile = value2;
      }
    }
    {
      const value2 = init["targetsConst"];
      if (value2 !== void 0) {
        target.targetsConst = value2;
      }
    }
    {
      const value2 = init["targetsEnum"];
      if (value2 !== void 0) {
        target.targetsEnum = value2;
      }
    }
    {
      const value2 = init["targetsEnumerant"];
      if (value2 !== void 0) {
        target.targetsEnumerant = value2;
      }
    }
    {
      const value2 = init["targetsStruct"];
      if (value2 !== void 0) {
        target.targetsStruct = value2;
      }
    }
    {
      const value2 = init["targetsField"];
      if (value2 !== void 0) {
        target.targetsField = value2;
      }
    }
    {
      const value2 = init["targetsUnion"];
      if (value2 !== void 0) {
        target.targetsUnion = value2;
      }
    }
    {
      const value2 = init["targetsGroup"];
      if (value2 !== void 0) {
        target.targetsGroup = value2;
      }
    }
    {
      const value2 = init["targetsInterface"];
      if (value2 !== void 0) {
        target.targetsInterface = value2;
      }
    }
    {
      const value2 = init["targetsMethod"];
      if (value2 !== void 0) {
        target.targetsMethod = value2;
      }
    }
    {
      const value2 = init["targetsParam"];
      if (value2 !== void 0) {
        target.targetsParam = value2;
      }
    }
    {
      const value2 = init["targetsAnnotation"];
      if (value2 !== void 0) {
        target.targetsAnnotation = value2;
      }
    }
  }
  _adoptType(value) {
    adopt(value, getPointer(3, this));
  }
  _disownType() {
    return disown(this.type);
  }
  get type() {
    return getStruct(3, Type, this);
  }
  _hasType() {
    return !isNull(getPointer(3, this));
  }
  _initType() {
    return initStructAt(3, Type, this);
  }
  set type(value) {
    copyFrom(value, getPointer(3, this));
  }
  get targetsFile() {
    return getBit(112, this);
  }
  set targetsFile(value) {
    setBit(112, value, this);
  }
  get targetsConst() {
    return getBit(113, this);
  }
  set targetsConst(value) {
    setBit(113, value, this);
  }
  get targetsEnum() {
    return getBit(114, this);
  }
  set targetsEnum(value) {
    setBit(114, value, this);
  }
  get targetsEnumerant() {
    return getBit(115, this);
  }
  set targetsEnumerant(value) {
    setBit(115, value, this);
  }
  get targetsStruct() {
    return getBit(116, this);
  }
  set targetsStruct(value) {
    setBit(116, value, this);
  }
  get targetsField() {
    return getBit(117, this);
  }
  set targetsField(value) {
    setBit(117, value, this);
  }
  get targetsUnion() {
    return getBit(118, this);
  }
  set targetsUnion(value) {
    setBit(118, value, this);
  }
  get targetsGroup() {
    return getBit(119, this);
  }
  set targetsGroup(value) {
    setBit(119, value, this);
  }
  get targetsInterface() {
    return getBit(120, this);
  }
  set targetsInterface(value) {
    setBit(120, value, this);
  }
  get targetsMethod() {
    return getBit(121, this);
  }
  set targetsMethod(value) {
    setBit(121, value, this);
  }
  get targetsParam() {
    return getBit(122, this);
  }
  set targetsParam(value) {
    setBit(122, value, this);
  }
  get targetsAnnotation() {
    return getBit(123, this);
  }
  set targetsAnnotation(value) {
    setBit(123, value, this);
  }
  toString() {
    return "Node_Annotation_" + super.toString();
  }
}
const Node_Which = {
  FILE: 0,
  /**
  * Name to present to humans to identify this Node.  You should not attempt to parse this.  Its
  * format could change.  It is not guaranteed to be unique.
  *
  * (On Zooko's triangle, this is the node's nickname.)
  *
  */
  STRUCT: 1,
  /**
  * If you want a shorter version of `displayName` (just naming this node, without its surrounding
  * scope), chop off this many characters from the beginning of `displayName`.
  *
  */
  ENUM: 2,
  /**
  * ID of the lexical parent node.  Typically, the scope node will have a NestedNode pointing back
  * at this node, but robust code should avoid relying on this (and, in fact, group nodes are not
  * listed in the outer struct's nestedNodes, since they are listed in the fields).  `scopeId` is
  * zero if the node has no parent, which is normally only the case with files, but should be
  * allowed for any kind of node (in order to make runtime type generation easier).
  *
  */
  INTERFACE: 3,
  /**
  * List of nodes nested within this node, along with the names under which they were declared.
  *
  */
  CONST: 4,
  /**
  * Annotations applied to this node.
  *
  */
  ANNOTATION: 5
};
class Node extends Struct {
  static FILE = Node_Which.FILE;
  static STRUCT = Node_Which.STRUCT;
  static ENUM = Node_Which.ENUM;
  static INTERFACE = Node_Which.INTERFACE;
  static CONST = Node_Which.CONST;
  static ANNOTATION = Node_Which.ANNOTATION;
  static Parameter = Node_Parameter;
  static NestedNode = Node_NestedNode;
  static SourceInfo = Node_SourceInfo;
  static _capnp = {
    displayName: "Node",
    id: "e682ab4cf923a417",
    typeId: 0xe682ab4cf923a417n,
    typeIdHex: "e682ab4cf923a417",
    size: new ObjectSize(40, 6),
    fields: [
      { name: "id", codeOrder: 0, ordinal: 0, kind: "slot", offset: 0, type: { kind: "uint64" } },
      { name: "displayName", codeOrder: 1, ordinal: 1, kind: "slot", offset: 0, type: { kind: "text" } },
      { name: "displayNamePrefixLength", codeOrder: 2, ordinal: 2, kind: "slot", offset: 2, type: { kind: "uint32" } },
      { name: "scopeId", codeOrder: 3, ordinal: 3, kind: "slot", offset: 2, type: { kind: "uint64" } },
      { name: "parameters", codeOrder: 4, ordinal: 32, kind: "slot", offset: 5, type: { kind: "list", elementType: { kind: "struct", typeId: 0xb9521bccf10fa3b1n, typeIdHex: "b9521bccf10fa3b1", displayName: "Parameter" } } },
      { name: "isGeneric", codeOrder: 5, ordinal: 33, kind: "slot", offset: 288, type: { kind: "bool" } },
      { name: "nestedNodes", codeOrder: 6, ordinal: 4, kind: "slot", offset: 1, type: { kind: "list", elementType: { kind: "struct", typeId: 0xdebf55bbfa0fc242n, typeIdHex: "debf55bbfa0fc242", displayName: "NestedNode" } } },
      { name: "annotations", codeOrder: 7, ordinal: 5, kind: "slot", offset: 2, type: { kind: "list", elementType: { kind: "struct", typeId: 0xf1c8950dab257542n, typeIdHex: "f1c8950dab257542", displayName: "Annotation" } } },
      { name: "file", codeOrder: 8, ordinal: 6, discriminantValue: 0, kind: "slot", offset: 0, type: { kind: "void" } },
      { name: "struct", codeOrder: 9, ordinal: 7, discriminantValue: 1, kind: "group", type: { kind: "group", typeId: 0x9ea0b19b37fb4435n, typeIdHex: "9ea0b19b37fb4435", displayName: "struct" } },
      { name: "enum", codeOrder: 10, ordinal: 8, discriminantValue: 2, kind: "group", type: { kind: "group", typeId: 0xb54ab3364333f598n, typeIdHex: "b54ab3364333f598", displayName: "enum" } },
      { name: "interface", codeOrder: 11, ordinal: 9, discriminantValue: 3, kind: "group", type: { kind: "group", typeId: 0xe82753cff0c2218fn, typeIdHex: "e82753cff0c2218f", displayName: "interface" } },
      { name: "const", codeOrder: 12, ordinal: 10, discriminantValue: 4, kind: "group", type: { kind: "group", typeId: 0xb18aa5ac7a0d9420n, typeIdHex: "b18aa5ac7a0d9420", displayName: "const" } },
      { name: "annotation", codeOrder: 13, ordinal: 11, discriminantValue: 5, kind: "group", type: { kind: "group", typeId: 0xec1619d4400a0290n, typeIdHex: "ec1619d4400a0290", displayName: "annotation" } }
    ]
  };
  static _Parameters;
  static _NestedNodes;
  static _Annotations;
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["id"];
      if (value2 !== void 0) {
        target.id = value2;
      }
    }
    {
      const value2 = init["displayName"];
      if (value2 !== void 0) {
        target.displayName = value2;
      }
    }
    {
      const value2 = init["displayNamePrefixLength"];
      if (value2 !== void 0) {
        target.displayNamePrefixLength = value2;
      }
    }
    {
      const value2 = init["scopeId"];
      if (value2 !== void 0) {
        target.scopeId = value2;
      }
    }
    {
      const value2 = init["parameters"];
      if (value2 !== void 0) {
        if (value2 instanceof List) {
          target.parameters = value2;
        } else {
          const values = Array.isArray(value2) ? value2 : Array.from(value2);
          const list = target._initParameters(values.length);
          for (let index = 0; index < values.length; index++) {
            const item = values[index];
            if (item instanceof Node_Parameter) {
              list.set(index, item);
            } else {
              Node_Parameter._applyInit(list.get(index), item);
            }
          }
        }
      }
    }
    {
      const value2 = init["isGeneric"];
      if (value2 !== void 0) {
        target.isGeneric = value2;
      }
    }
    {
      const value2 = init["nestedNodes"];
      if (value2 !== void 0) {
        if (value2 instanceof List) {
          target.nestedNodes = value2;
        } else {
          const values = Array.isArray(value2) ? value2 : Array.from(value2);
          const list = target._initNestedNodes(values.length);
          for (let index = 0; index < values.length; index++) {
            const item = values[index];
            if (item instanceof Node_NestedNode) {
              list.set(index, item);
            } else {
              Node_NestedNode._applyInit(list.get(index), item);
            }
          }
        }
      }
    }
    {
      const value2 = init["annotations"];
      if (value2 !== void 0) {
        if (value2 instanceof List) {
          target.annotations = value2;
        } else {
          const values = Array.isArray(value2) ? value2 : Array.from(value2);
          const list = target._initAnnotations(values.length);
          for (let index = 0; index < values.length; index++) {
            const item = values[index];
            if (item instanceof Annotation) {
              list.set(index, item);
            } else {
              Annotation._applyInit(list.get(index), item);
            }
          }
        }
      }
    }
    {
      const value2 = init["file"];
      if (value2 !== void 0) {
        target.file = true;
      }
    }
    {
      const value2 = init["struct"];
      if (value2 !== void 0) {
        Node_Struct._applyInit(target._initStruct(), value2);
      }
    }
    {
      const value2 = init["enum"];
      if (value2 !== void 0) {
        Node_Enum._applyInit(target._initEnum(), value2);
      }
    }
    {
      const value2 = init["interface"];
      if (value2 !== void 0) {
        Node_Interface._applyInit(target._initInterface(), value2);
      }
    }
    {
      const value2 = init["const"];
      if (value2 !== void 0) {
        Node_Const._applyInit(target._initConst(), value2);
      }
    }
    {
      const value2 = init["annotation"];
      if (value2 !== void 0) {
        Node_Annotation._applyInit(target._initAnnotation(), value2);
      }
    }
  }
  get id() {
    return getUint64(0, this);
  }
  set id(value) {
    setUint64(0, value, this);
  }
  /**
  * Name to present to humans to identify this Node.  You should not attempt to parse this.  Its
  * format could change.  It is not guaranteed to be unique.
  *
  * (On Zooko's triangle, this is the node's nickname.)
  *
  */
  get displayName() {
    return getText(0, this);
  }
  set displayName(value) {
    setText(0, value, this);
  }
  /**
  * If you want a shorter version of `displayName` (just naming this node, without its surrounding
  * scope), chop off this many characters from the beginning of `displayName`.
  *
  */
  get displayNamePrefixLength() {
    return getUint32(8, this);
  }
  set displayNamePrefixLength(value) {
    setUint32(8, value, this);
  }
  /**
  * ID of the lexical parent node.  Typically, the scope node will have a NestedNode pointing back
  * at this node, but robust code should avoid relying on this (and, in fact, group nodes are not
  * listed in the outer struct's nestedNodes, since they are listed in the fields).  `scopeId` is
  * zero if the node has no parent, which is normally only the case with files, but should be
  * allowed for any kind of node (in order to make runtime type generation easier).
  *
  */
  get scopeId() {
    return getUint64(16, this);
  }
  set scopeId(value) {
    setUint64(16, value, this);
  }
  _adoptParameters(value) {
    adopt(value, getPointer(5, this));
  }
  _disownParameters() {
    return disown(this.parameters);
  }
  /**
  * If this node is parameterized (generic), the list of parameters. Empty for non-generic types.
  *
  */
  get parameters() {
    return getList(5, Node._Parameters, this);
  }
  _hasParameters() {
    return !isNull(getPointer(5, this));
  }
  _initParameters(length) {
    return initList(5, Node._Parameters, length, this);
  }
  set parameters(value) {
    copyFrom(value, getPointer(5, this));
  }
  /**
  * True if this node is generic, meaning that it or one of its parent scopes has a non-empty
  * `parameters`.
  *
  */
  get isGeneric() {
    return getBit(288, this);
  }
  set isGeneric(value) {
    setBit(288, value, this);
  }
  _adoptNestedNodes(value) {
    adopt(value, getPointer(1, this));
  }
  _disownNestedNodes() {
    return disown(this.nestedNodes);
  }
  /**
  * List of nodes nested within this node, along with the names under which they were declared.
  *
  */
  get nestedNodes() {
    return getList(1, Node._NestedNodes, this);
  }
  _hasNestedNodes() {
    return !isNull(getPointer(1, this));
  }
  _initNestedNodes(length) {
    return initList(1, Node._NestedNodes, length, this);
  }
  set nestedNodes(value) {
    copyFrom(value, getPointer(1, this));
  }
  _adoptAnnotations(value) {
    adopt(value, getPointer(2, this));
  }
  _disownAnnotations() {
    return disown(this.annotations);
  }
  /**
  * Annotations applied to this node.
  *
  */
  get annotations() {
    return getList(2, Node._Annotations, this);
  }
  _hasAnnotations() {
    return !isNull(getPointer(2, this));
  }
  _initAnnotations(length) {
    return initList(2, Node._Annotations, length, this);
  }
  set annotations(value) {
    copyFrom(value, getPointer(2, this));
  }
  get _isFile() {
    return getUint16(12, this) === 0;
  }
  set file(_) {
    setUint16(12, 0, this);
  }
  get struct() {
    testWhich("struct", getUint16(12, this), 1, this);
    return getAs(Node_Struct, this);
  }
  _initStruct() {
    setUint16(12, 1, this);
    return getAs(Node_Struct, this);
  }
  get _isStruct() {
    return getUint16(12, this) === 1;
  }
  set struct(_) {
    setUint16(12, 1, this);
  }
  get enum() {
    testWhich("enum", getUint16(12, this), 2, this);
    return getAs(Node_Enum, this);
  }
  _initEnum() {
    setUint16(12, 2, this);
    return getAs(Node_Enum, this);
  }
  get _isEnum() {
    return getUint16(12, this) === 2;
  }
  set enum(_) {
    setUint16(12, 2, this);
  }
  get interface() {
    testWhich("interface", getUint16(12, this), 3, this);
    return getAs(Node_Interface, this);
  }
  _initInterface() {
    setUint16(12, 3, this);
    return getAs(Node_Interface, this);
  }
  get _isInterface() {
    return getUint16(12, this) === 3;
  }
  set interface(_) {
    setUint16(12, 3, this);
  }
  get const() {
    testWhich("const", getUint16(12, this), 4, this);
    return getAs(Node_Const, this);
  }
  _initConst() {
    setUint16(12, 4, this);
    return getAs(Node_Const, this);
  }
  get _isConst() {
    return getUint16(12, this) === 4;
  }
  set const(_) {
    setUint16(12, 4, this);
  }
  get annotation() {
    testWhich("annotation", getUint16(12, this), 5, this);
    return getAs(Node_Annotation, this);
  }
  _initAnnotation() {
    setUint16(12, 5, this);
    return getAs(Node_Annotation, this);
  }
  get _isAnnotation() {
    return getUint16(12, this) === 5;
  }
  set annotation(_) {
    setUint16(12, 5, this);
  }
  toString() {
    return "Node_" + super.toString();
  }
  which() {
    return getUint16(12, this);
  }
  _set(value) {
    switch (value.which) {
      case "file": {
        this.file = true;
        return;
      }
      case "struct": {
        this.struct = true;
        return;
      }
      case "enum": {
        this.enum = true;
        return;
      }
      case "interface": {
        this.interface = true;
        return;
      }
      case "const": {
        this.const = true;
        return;
      }
      case "annotation": {
        this.annotation = true;
        return;
      }
    }
  }
  _match(cases) {
    const which = this.which();
    switch (which) {
      case 0: {
        const callback = cases["file"];
        if (callback) {
          return callback();
        }
        break;
      }
      case 1: {
        const callback = cases["struct"];
        if (callback) {
          return callback(this.struct);
        }
        break;
      }
      case 2: {
        const callback = cases["enum"];
        if (callback) {
          return callback(this.enum);
        }
        break;
      }
      case 3: {
        const callback = cases["interface"];
        if (callback) {
          return callback(this.interface);
        }
        break;
      }
      case 4: {
        const callback = cases["const"];
        if (callback) {
          return callback(this.const);
        }
        break;
      }
      case 5: {
        const callback = cases["annotation"];
        if (callback) {
          return callback(this.annotation);
        }
        break;
      }
    }
    if (cases._) {
      return cases._(which);
    }
    throw new Error("Unhandled Node union case: " + which);
  }
}
class Field_Slot extends Struct {
  static _capnp = {
    displayName: "slot",
    id: "c42305476bb4746f",
    typeId: 0xc42305476bb4746fn,
    typeIdHex: "c42305476bb4746f",
    size: new ObjectSize(24, 4),
    fields: [
      { name: "offset", codeOrder: 0, ordinal: 4, kind: "slot", offset: 1, type: { kind: "uint32" } },
      { name: "type", codeOrder: 1, ordinal: 5, kind: "slot", offset: 2, type: { kind: "struct", typeId: 0xd07378ede1f9cc60n, typeIdHex: "d07378ede1f9cc60", displayName: "Type" } },
      { name: "defaultValue", codeOrder: 2, ordinal: 6, kind: "slot", offset: 3, type: { kind: "struct", typeId: 0xce23dcd2d7b00c9bn, typeIdHex: "ce23dcd2d7b00c9b", displayName: "Value" } },
      { name: "hadExplicitDefault", codeOrder: 3, ordinal: 10, kind: "slot", offset: 128, type: { kind: "bool" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["offset"];
      if (value2 !== void 0) {
        target.offset = value2;
      }
    }
    {
      const value2 = init["type"];
      if (value2 !== void 0) {
        if (value2 instanceof Type) {
          target.type = value2;
        } else {
          Type._applyInit(target._initType(), value2);
        }
      }
    }
    {
      const value2 = init["defaultValue"];
      if (value2 !== void 0) {
        if (value2 instanceof Value) {
          target.defaultValue = value2;
        } else {
          Value._applyInit(target._initDefaultValue(), value2);
        }
      }
    }
    {
      const value2 = init["hadExplicitDefault"];
      if (value2 !== void 0) {
        target.hadExplicitDefault = value2;
      }
    }
  }
  /**
  * Offset, in units of the field's size, from the beginning of the section in which the field
  * resides.  E.g. for a UInt32 field, multiply this by 4 to get the byte offset from the
  * beginning of the data section.
  *
  */
  get offset() {
    return getUint32(4, this);
  }
  set offset(value) {
    setUint32(4, value, this);
  }
  _adoptType(value) {
    adopt(value, getPointer(2, this));
  }
  _disownType() {
    return disown(this.type);
  }
  get type() {
    return getStruct(2, Type, this);
  }
  _hasType() {
    return !isNull(getPointer(2, this));
  }
  _initType() {
    return initStructAt(2, Type, this);
  }
  set type(value) {
    copyFrom(value, getPointer(2, this));
  }
  _adoptDefaultValue(value) {
    adopt(value, getPointer(3, this));
  }
  _disownDefaultValue() {
    return disown(this.defaultValue);
  }
  get defaultValue() {
    return getStruct(3, Value, this);
  }
  _hasDefaultValue() {
    return !isNull(getPointer(3, this));
  }
  _initDefaultValue() {
    return initStructAt(3, Value, this);
  }
  set defaultValue(value) {
    copyFrom(value, getPointer(3, this));
  }
  /**
  * Whether the default value was specified explicitly.  Non-explicit default values are always
  * zero or empty values.  Usually, whether the default value was explicit shouldn't matter.
  * The main use case for this flag is for structs representing method parameters:
  * explicitly-defaulted parameters may be allowed to be omitted when calling the method.
  *
  */
  get hadExplicitDefault() {
    return getBit(128, this);
  }
  set hadExplicitDefault(value) {
    setBit(128, value, this);
  }
  toString() {
    return "Field_Slot_" + super.toString();
  }
}
class Field_Group extends Struct {
  static _capnp = {
    displayName: "group",
    id: "cafccddb68db1d11",
    typeId: 0xcafccddb68db1d11n,
    typeIdHex: "cafccddb68db1d11",
    size: new ObjectSize(24, 4),
    fields: [
      { name: "typeId", codeOrder: 0, ordinal: 7, kind: "slot", offset: 2, type: { kind: "uint64" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["typeId"];
      if (value2 !== void 0) {
        target.typeId = value2;
      }
    }
  }
  /**
  * The ID of the group's node.
  *
  */
  get typeId() {
    return getUint64(16, this);
  }
  set typeId(value) {
    setUint64(16, value, this);
  }
  toString() {
    return "Field_Group_" + super.toString();
  }
}
const Field_Ordinal_Which = {
  IMPLICIT: 0,
  /**
  * The original ordinal number given to the field.  You probably should NOT use this; if you need
  * a numeric identifier for a field, use its position within the field array for its scope.
  * The ordinal is given here mainly just so that the original schema text can be reproduced given
  * the compiled version -- i.e. so that `capnp compile -ocapnp` can do its job.
  *
  */
  EXPLICIT: 1
};
class Field_Ordinal extends Struct {
  static IMPLICIT = Field_Ordinal_Which.IMPLICIT;
  static EXPLICIT = Field_Ordinal_Which.EXPLICIT;
  static _capnp = {
    displayName: "ordinal",
    id: "bb90d5c287870be6",
    typeId: 0xbb90d5c287870be6n,
    typeIdHex: "bb90d5c287870be6",
    size: new ObjectSize(24, 4),
    fields: [
      { name: "implicit", codeOrder: 0, ordinal: 8, discriminantValue: 0, kind: "slot", offset: 0, type: { kind: "void" } },
      { name: "explicit", codeOrder: 1, ordinal: 9, discriminantValue: 1, kind: "slot", offset: 6, type: { kind: "uint16" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["implicit"];
      if (value2 !== void 0) {
        target.implicit = true;
      }
    }
    {
      const value2 = init["explicit"];
      if (value2 !== void 0) {
        target.explicit = value2;
      }
    }
  }
  get _isImplicit() {
    return getUint16(10, this) === 0;
  }
  set implicit(_) {
    setUint16(10, 0, this);
  }
  /**
  * The original ordinal number given to the field.  You probably should NOT use this; if you need
  * a numeric identifier for a field, use its position within the field array for its scope.
  * The ordinal is given here mainly just so that the original schema text can be reproduced given
  * the compiled version -- i.e. so that `capnp compile -ocapnp` can do its job.
  *
  */
  get explicit() {
    testWhich("explicit", getUint16(10, this), 1, this);
    return getUint16(12, this);
  }
  get _isExplicit() {
    return getUint16(10, this) === 1;
  }
  set explicit(value) {
    setUint16(10, 1, this);
    setUint16(12, value, this);
  }
  toString() {
    return "Field_Ordinal_" + super.toString();
  }
  which() {
    return getUint16(10, this);
  }
  _set(value) {
    switch (value.which) {
      case "implicit": {
        this.implicit = true;
        return;
      }
      case "explicit": {
        this.explicit = value.value;
        return;
      }
    }
  }
  _match(cases) {
    const which = this.which();
    switch (which) {
      case 0: {
        const callback = cases["implicit"];
        if (callback) {
          return callback();
        }
        break;
      }
      case 1: {
        const callback = cases["explicit"];
        if (callback) {
          return callback(this.explicit);
        }
        break;
      }
    }
    if (cases._) {
      return cases._(which);
    }
    throw new Error("Unhandled Field_Ordinal union case: " + which);
  }
}
const Field_Which = {
  SLOT: 0,
  /**
  * Indicates where this member appeared in the code, relative to other members.
  * Code ordering may have semantic relevance -- programmers tend to place related fields
  * together.  So, using code ordering makes sense in human-readable formats where ordering is
  * otherwise irrelevant, like JSON.  The values of codeOrder are tightly-packed, so the maximum
  * value is count(members) - 1.  Fields that are members of a union are only ordered relative to
  * the other members of that union, so the maximum value there is count(union.members).
  *
  */
  GROUP: 1
};
class Field extends Struct {
  static NO_DISCRIMINANT = 65535;
  static SLOT = Field_Which.SLOT;
  static GROUP = Field_Which.GROUP;
  static _capnp = {
    displayName: "Field",
    id: "9aad50a41f4af45f",
    typeId: 0x9aad50a41f4af45fn,
    typeIdHex: "9aad50a41f4af45f",
    size: new ObjectSize(24, 4),
    fields: [
      { name: "name", codeOrder: 0, ordinal: 0, kind: "slot", offset: 0, type: { kind: "text" } },
      { name: "codeOrder", codeOrder: 1, ordinal: 1, kind: "slot", offset: 0, type: { kind: "uint16" } },
      { name: "annotations", codeOrder: 2, ordinal: 2, kind: "slot", offset: 1, type: { kind: "list", elementType: { kind: "struct", typeId: 0xf1c8950dab257542n, typeIdHex: "f1c8950dab257542", displayName: "Annotation" } } },
      { name: "discriminantValue", codeOrder: 3, ordinal: 3, kind: "slot", offset: 1, type: { kind: "uint16" } },
      { name: "slot", codeOrder: 4, ordinal: 4, discriminantValue: 0, kind: "group", type: { kind: "group", typeId: 0xc42305476bb4746fn, typeIdHex: "c42305476bb4746f", displayName: "slot" } },
      { name: "group", codeOrder: 5, ordinal: 5, discriminantValue: 1, kind: "group", type: { kind: "group", typeId: 0xcafccddb68db1d11n, typeIdHex: "cafccddb68db1d11", displayName: "group" } },
      { name: "ordinal", codeOrder: 6, ordinal: 6, kind: "group", type: { kind: "group", typeId: 0xbb90d5c287870be6n, typeIdHex: "bb90d5c287870be6", displayName: "ordinal" } }
    ],
    defaultDiscriminantValue: getUint16Mask(65535)
  };
  static _Annotations;
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["name"];
      if (value2 !== void 0) {
        target.name = value2;
      }
    }
    {
      const value2 = init["codeOrder"];
      if (value2 !== void 0) {
        target.codeOrder = value2;
      }
    }
    {
      const value2 = init["annotations"];
      if (value2 !== void 0) {
        if (value2 instanceof List) {
          target.annotations = value2;
        } else {
          const values = Array.isArray(value2) ? value2 : Array.from(value2);
          const list = target._initAnnotations(values.length);
          for (let index = 0; index < values.length; index++) {
            const item = values[index];
            if (item instanceof Annotation) {
              list.set(index, item);
            } else {
              Annotation._applyInit(list.get(index), item);
            }
          }
        }
      }
    }
    {
      const value2 = init["discriminantValue"];
      if (value2 !== void 0) {
        target.discriminantValue = value2;
      }
    }
    {
      const value2 = init["slot"];
      if (value2 !== void 0) {
        Field_Slot._applyInit(target._initSlot(), value2);
      }
    }
    {
      const value2 = init["group"];
      if (value2 !== void 0) {
        Field_Group._applyInit(target._initGroup(), value2);
      }
    }
    {
      const value2 = init["ordinal"];
      if (value2 !== void 0) {
        Field_Ordinal._applyInit(target._initOrdinal(), value2);
      }
    }
  }
  get name() {
    return getText(0, this);
  }
  set name(value) {
    setText(0, value, this);
  }
  /**
  * Indicates where this member appeared in the code, relative to other members.
  * Code ordering may have semantic relevance -- programmers tend to place related fields
  * together.  So, using code ordering makes sense in human-readable formats where ordering is
  * otherwise irrelevant, like JSON.  The values of codeOrder are tightly-packed, so the maximum
  * value is count(members) - 1.  Fields that are members of a union are only ordered relative to
  * the other members of that union, so the maximum value there is count(union.members).
  *
  */
  get codeOrder() {
    return getUint16(0, this);
  }
  set codeOrder(value) {
    setUint16(0, value, this);
  }
  _adoptAnnotations(value) {
    adopt(value, getPointer(1, this));
  }
  _disownAnnotations() {
    return disown(this.annotations);
  }
  get annotations() {
    return getList(1, Field._Annotations, this);
  }
  _hasAnnotations() {
    return !isNull(getPointer(1, this));
  }
  _initAnnotations(length) {
    return initList(1, Field._Annotations, length, this);
  }
  set annotations(value) {
    copyFrom(value, getPointer(1, this));
  }
  /**
  * If the field is in a union, this is the value which the union's discriminant should take when
  * the field is active.  If the field is not in a union, this is 0xffff.
  *
  */
  get discriminantValue() {
    return getUint16(2, this, Field._capnp.defaultDiscriminantValue);
  }
  set discriminantValue(value) {
    setUint16(2, value, this, Field._capnp.defaultDiscriminantValue);
  }
  /**
  * A regular, non-group, non-fixed-list field.
  *
  */
  get slot() {
    testWhich("slot", getUint16(8, this), 0, this);
    return getAs(Field_Slot, this);
  }
  _initSlot() {
    setUint16(8, 0, this);
    return getAs(Field_Slot, this);
  }
  get _isSlot() {
    return getUint16(8, this) === 0;
  }
  set slot(_) {
    setUint16(8, 0, this);
  }
  /**
  * A group.
  *
  */
  get group() {
    testWhich("group", getUint16(8, this), 1, this);
    return getAs(Field_Group, this);
  }
  _initGroup() {
    setUint16(8, 1, this);
    return getAs(Field_Group, this);
  }
  get _isGroup() {
    return getUint16(8, this) === 1;
  }
  set group(_) {
    setUint16(8, 1, this);
  }
  get ordinal() {
    return getAs(Field_Ordinal, this);
  }
  _initOrdinal() {
    return getAs(Field_Ordinal, this);
  }
  toString() {
    return "Field_" + super.toString();
  }
  which() {
    return getUint16(8, this);
  }
  _set(value) {
    switch (value.which) {
      case "slot": {
        this.slot = true;
        return;
      }
      case "group": {
        this.group = true;
        return;
      }
    }
  }
  _match(cases) {
    const which = this.which();
    switch (which) {
      case 0: {
        const callback = cases["slot"];
        if (callback) {
          return callback(this.slot);
        }
        break;
      }
      case 1: {
        const callback = cases["group"];
        if (callback) {
          return callback(this.group);
        }
        break;
      }
    }
    if (cases._) {
      return cases._(which);
    }
    throw new Error("Unhandled Field union case: " + which);
  }
}
class Enumerant extends Struct {
  static _capnp = {
    displayName: "Enumerant",
    id: "978a7cebdc549a4d",
    typeId: 0x978a7cebdc549a4dn,
    typeIdHex: "978a7cebdc549a4d",
    size: new ObjectSize(8, 2),
    fields: [
      { name: "name", codeOrder: 0, ordinal: 0, kind: "slot", offset: 0, type: { kind: "text" } },
      { name: "codeOrder", codeOrder: 1, ordinal: 1, kind: "slot", offset: 0, type: { kind: "uint16" } },
      { name: "annotations", codeOrder: 2, ordinal: 2, kind: "slot", offset: 1, type: { kind: "list", elementType: { kind: "struct", typeId: 0xf1c8950dab257542n, typeIdHex: "f1c8950dab257542", displayName: "Annotation" } } }
    ]
  };
  static _Annotations;
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["name"];
      if (value2 !== void 0) {
        target.name = value2;
      }
    }
    {
      const value2 = init["codeOrder"];
      if (value2 !== void 0) {
        target.codeOrder = value2;
      }
    }
    {
      const value2 = init["annotations"];
      if (value2 !== void 0) {
        if (value2 instanceof List) {
          target.annotations = value2;
        } else {
          const values = Array.isArray(value2) ? value2 : Array.from(value2);
          const list = target._initAnnotations(values.length);
          for (let index = 0; index < values.length; index++) {
            const item = values[index];
            if (item instanceof Annotation) {
              list.set(index, item);
            } else {
              Annotation._applyInit(list.get(index), item);
            }
          }
        }
      }
    }
  }
  get name() {
    return getText(0, this);
  }
  set name(value) {
    setText(0, value, this);
  }
  /**
  * Specifies order in which the enumerants were declared in the code.
  * Like utils.Field.codeOrder.
  *
  */
  get codeOrder() {
    return getUint16(0, this);
  }
  set codeOrder(value) {
    setUint16(0, value, this);
  }
  _adoptAnnotations(value) {
    adopt(value, getPointer(1, this));
  }
  _disownAnnotations() {
    return disown(this.annotations);
  }
  get annotations() {
    return getList(1, Enumerant._Annotations, this);
  }
  _hasAnnotations() {
    return !isNull(getPointer(1, this));
  }
  _initAnnotations(length) {
    return initList(1, Enumerant._Annotations, length, this);
  }
  set annotations(value) {
    copyFrom(value, getPointer(1, this));
  }
  toString() {
    return "Enumerant_" + super.toString();
  }
}
class Superclass extends Struct {
  static _capnp = {
    displayName: "Superclass",
    id: "a9962a9ed0a4d7f8",
    typeId: 0xa9962a9ed0a4d7f8n,
    typeIdHex: "a9962a9ed0a4d7f8",
    size: new ObjectSize(8, 1),
    fields: [
      { name: "id", codeOrder: 0, ordinal: 0, kind: "slot", offset: 0, type: { kind: "uint64" } },
      { name: "brand", codeOrder: 1, ordinal: 1, kind: "slot", offset: 0, type: { kind: "struct", typeId: 0x903455f06065422bn, typeIdHex: "903455f06065422b", displayName: "Brand" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["id"];
      if (value2 !== void 0) {
        target.id = value2;
      }
    }
    {
      const value2 = init["brand"];
      if (value2 !== void 0) {
        if (value2 instanceof Brand) {
          target.brand = value2;
        } else {
          Brand._applyInit(target._initBrand(), value2);
        }
      }
    }
  }
  get id() {
    return getUint64(0, this);
  }
  set id(value) {
    setUint64(0, value, this);
  }
  _adoptBrand(value) {
    adopt(value, getPointer(0, this));
  }
  _disownBrand() {
    return disown(this.brand);
  }
  get brand() {
    return getStruct(0, Brand, this);
  }
  _hasBrand() {
    return !isNull(getPointer(0, this));
  }
  _initBrand() {
    return initStructAt(0, Brand, this);
  }
  set brand(value) {
    copyFrom(value, getPointer(0, this));
  }
  toString() {
    return "Superclass_" + super.toString();
  }
}
class Method extends Struct {
  static _capnp = {
    displayName: "Method",
    id: "9500cce23b334d80",
    typeId: 0x9500cce23b334d80n,
    typeIdHex: "9500cce23b334d80",
    size: new ObjectSize(24, 5),
    fields: [
      { name: "name", codeOrder: 0, ordinal: 0, kind: "slot", offset: 0, type: { kind: "text" } },
      { name: "codeOrder", codeOrder: 1, ordinal: 1, kind: "slot", offset: 0, type: { kind: "uint16" } },
      { name: "implicitParameters", codeOrder: 2, ordinal: 7, kind: "slot", offset: 4, type: { kind: "list", elementType: { kind: "struct", typeId: 0xb9521bccf10fa3b1n, typeIdHex: "b9521bccf10fa3b1", displayName: "Parameter" } } },
      { name: "paramStructType", codeOrder: 3, ordinal: 2, kind: "slot", offset: 1, type: { kind: "uint64" } },
      { name: "paramBrand", codeOrder: 4, ordinal: 5, kind: "slot", offset: 2, type: { kind: "struct", typeId: 0x903455f06065422bn, typeIdHex: "903455f06065422b", displayName: "Brand" } },
      { name: "resultStructType", codeOrder: 5, ordinal: 3, kind: "slot", offset: 2, type: { kind: "uint64" } },
      { name: "resultBrand", codeOrder: 6, ordinal: 6, kind: "slot", offset: 3, type: { kind: "struct", typeId: 0x903455f06065422bn, typeIdHex: "903455f06065422b", displayName: "Brand" } },
      { name: "annotations", codeOrder: 7, ordinal: 4, kind: "slot", offset: 1, type: { kind: "list", elementType: { kind: "struct", typeId: 0xf1c8950dab257542n, typeIdHex: "f1c8950dab257542", displayName: "Annotation" } } }
    ]
  };
  static _ImplicitParameters;
  static _Annotations;
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["name"];
      if (value2 !== void 0) {
        target.name = value2;
      }
    }
    {
      const value2 = init["codeOrder"];
      if (value2 !== void 0) {
        target.codeOrder = value2;
      }
    }
    {
      const value2 = init["implicitParameters"];
      if (value2 !== void 0) {
        if (value2 instanceof List) {
          target.implicitParameters = value2;
        } else {
          const values = Array.isArray(value2) ? value2 : Array.from(value2);
          const list = target._initImplicitParameters(values.length);
          for (let index = 0; index < values.length; index++) {
            const item = values[index];
            if (item instanceof Node_Parameter) {
              list.set(index, item);
            } else {
              Node_Parameter._applyInit(list.get(index), item);
            }
          }
        }
      }
    }
    {
      const value2 = init["paramStructType"];
      if (value2 !== void 0) {
        target.paramStructType = value2;
      }
    }
    {
      const value2 = init["paramBrand"];
      if (value2 !== void 0) {
        if (value2 instanceof Brand) {
          target.paramBrand = value2;
        } else {
          Brand._applyInit(target._initParamBrand(), value2);
        }
      }
    }
    {
      const value2 = init["resultStructType"];
      if (value2 !== void 0) {
        target.resultStructType = value2;
      }
    }
    {
      const value2 = init["resultBrand"];
      if (value2 !== void 0) {
        if (value2 instanceof Brand) {
          target.resultBrand = value2;
        } else {
          Brand._applyInit(target._initResultBrand(), value2);
        }
      }
    }
    {
      const value2 = init["annotations"];
      if (value2 !== void 0) {
        if (value2 instanceof List) {
          target.annotations = value2;
        } else {
          const values = Array.isArray(value2) ? value2 : Array.from(value2);
          const list = target._initAnnotations(values.length);
          for (let index = 0; index < values.length; index++) {
            const item = values[index];
            if (item instanceof Annotation) {
              list.set(index, item);
            } else {
              Annotation._applyInit(list.get(index), item);
            }
          }
        }
      }
    }
  }
  get name() {
    return getText(0, this);
  }
  set name(value) {
    setText(0, value, this);
  }
  /**
  * Specifies order in which the methods were declared in the code.
  * Like utils.Field.codeOrder.
  *
  */
  get codeOrder() {
    return getUint16(0, this);
  }
  set codeOrder(value) {
    setUint16(0, value, this);
  }
  _adoptImplicitParameters(value) {
    adopt(value, getPointer(4, this));
  }
  _disownImplicitParameters() {
    return disown(this.implicitParameters);
  }
  /**
  * The parameters listed in [] (typically, type / generic parameters), whose bindings are intended
  * to be inferred rather than specified explicitly, although not all languages support this.
  *
  */
  get implicitParameters() {
    return getList(4, Method._ImplicitParameters, this);
  }
  _hasImplicitParameters() {
    return !isNull(getPointer(4, this));
  }
  _initImplicitParameters(length) {
    return initList(4, Method._ImplicitParameters, length, this);
  }
  set implicitParameters(value) {
    copyFrom(value, getPointer(4, this));
  }
  /**
  * ID of the parameter struct type.  If a named parameter list was specified in the method
  * declaration (rather than a single struct parameter type) then a corresponding struct type is
  * auto-generated.  Such an auto-generated type will not be listed in the interface's
  * `nestedNodes` and its `scopeId` will be zero -- it is completely detached from the namespace.
  * (Awkwardly, it does of course inherit generic parameters from the method's scope, which makes
  * this a situation where you can't just climb the scope chain to find where a particular
  * generic parameter was introduced. Making the `scopeId` zero was a mistake.)
  *
  */
  get paramStructType() {
    return getUint64(8, this);
  }
  set paramStructType(value) {
    setUint64(8, value, this);
  }
  _adoptParamBrand(value) {
    adopt(value, getPointer(2, this));
  }
  _disownParamBrand() {
    return disown(this.paramBrand);
  }
  /**
  * Brand of param struct type.
  *
  */
  get paramBrand() {
    return getStruct(2, Brand, this);
  }
  _hasParamBrand() {
    return !isNull(getPointer(2, this));
  }
  _initParamBrand() {
    return initStructAt(2, Brand, this);
  }
  set paramBrand(value) {
    copyFrom(value, getPointer(2, this));
  }
  /**
  * ID of the return struct type; similar to `paramStructType`.
  *
  */
  get resultStructType() {
    return getUint64(16, this);
  }
  set resultStructType(value) {
    setUint64(16, value, this);
  }
  _adoptResultBrand(value) {
    adopt(value, getPointer(3, this));
  }
  _disownResultBrand() {
    return disown(this.resultBrand);
  }
  /**
  * Brand of result struct type.
  *
  */
  get resultBrand() {
    return getStruct(3, Brand, this);
  }
  _hasResultBrand() {
    return !isNull(getPointer(3, this));
  }
  _initResultBrand() {
    return initStructAt(3, Brand, this);
  }
  set resultBrand(value) {
    copyFrom(value, getPointer(3, this));
  }
  _adoptAnnotations(value) {
    adopt(value, getPointer(1, this));
  }
  _disownAnnotations() {
    return disown(this.annotations);
  }
  get annotations() {
    return getList(1, Method._Annotations, this);
  }
  _hasAnnotations() {
    return !isNull(getPointer(1, this));
  }
  _initAnnotations(length) {
    return initList(1, Method._Annotations, length, this);
  }
  set annotations(value) {
    copyFrom(value, getPointer(1, this));
  }
  toString() {
    return "Method_" + super.toString();
  }
}
class Type_List extends Struct {
  static _capnp = {
    displayName: "list",
    id: "87e739250a60ea97",
    typeId: 0x87e739250a60ea97n,
    typeIdHex: "87e739250a60ea97",
    size: new ObjectSize(24, 1),
    fields: [
      { name: "elementType", codeOrder: 0, ordinal: 14, kind: "slot", offset: 0, type: { kind: "struct", typeId: 0xd07378ede1f9cc60n, typeIdHex: "d07378ede1f9cc60", displayName: "Type" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["elementType"];
      if (value2 !== void 0) {
        if (value2 instanceof Type) {
          target.elementType = value2;
        } else {
          Type._applyInit(target._initElementType(), value2);
        }
      }
    }
  }
  _adoptElementType(value) {
    adopt(value, getPointer(0, this));
  }
  _disownElementType() {
    return disown(this.elementType);
  }
  get elementType() {
    return getStruct(0, Type, this);
  }
  _hasElementType() {
    return !isNull(getPointer(0, this));
  }
  _initElementType() {
    return initStructAt(0, Type, this);
  }
  set elementType(value) {
    copyFrom(value, getPointer(0, this));
  }
  toString() {
    return "Type_List_" + super.toString();
  }
}
class Type_Enum extends Struct {
  static _capnp = {
    displayName: "enum",
    id: "9e0e78711a7f87a9",
    typeId: 0x9e0e78711a7f87a9n,
    typeIdHex: "9e0e78711a7f87a9",
    size: new ObjectSize(24, 1),
    fields: [
      { name: "typeId", codeOrder: 0, ordinal: 15, kind: "slot", offset: 1, type: { kind: "uint64" } },
      { name: "brand", codeOrder: 1, ordinal: 21, kind: "slot", offset: 0, type: { kind: "struct", typeId: 0x903455f06065422bn, typeIdHex: "903455f06065422b", displayName: "Brand" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["typeId"];
      if (value2 !== void 0) {
        target.typeId = value2;
      }
    }
    {
      const value2 = init["brand"];
      if (value2 !== void 0) {
        if (value2 instanceof Brand) {
          target.brand = value2;
        } else {
          Brand._applyInit(target._initBrand(), value2);
        }
      }
    }
  }
  get typeId() {
    return getUint64(8, this);
  }
  set typeId(value) {
    setUint64(8, value, this);
  }
  _adoptBrand(value) {
    adopt(value, getPointer(0, this));
  }
  _disownBrand() {
    return disown(this.brand);
  }
  get brand() {
    return getStruct(0, Brand, this);
  }
  _hasBrand() {
    return !isNull(getPointer(0, this));
  }
  _initBrand() {
    return initStructAt(0, Brand, this);
  }
  set brand(value) {
    copyFrom(value, getPointer(0, this));
  }
  toString() {
    return "Type_Enum_" + super.toString();
  }
}
class Type_Struct extends Struct {
  static _capnp = {
    displayName: "struct",
    id: "ac3a6f60ef4cc6d3",
    typeId: 0xac3a6f60ef4cc6d3n,
    typeIdHex: "ac3a6f60ef4cc6d3",
    size: new ObjectSize(24, 1),
    fields: [
      { name: "typeId", codeOrder: 0, ordinal: 16, kind: "slot", offset: 1, type: { kind: "uint64" } },
      { name: "brand", codeOrder: 1, ordinal: 22, kind: "slot", offset: 0, type: { kind: "struct", typeId: 0x903455f06065422bn, typeIdHex: "903455f06065422b", displayName: "Brand" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["typeId"];
      if (value2 !== void 0) {
        target.typeId = value2;
      }
    }
    {
      const value2 = init["brand"];
      if (value2 !== void 0) {
        if (value2 instanceof Brand) {
          target.brand = value2;
        } else {
          Brand._applyInit(target._initBrand(), value2);
        }
      }
    }
  }
  get typeId() {
    return getUint64(8, this);
  }
  set typeId(value) {
    setUint64(8, value, this);
  }
  _adoptBrand(value) {
    adopt(value, getPointer(0, this));
  }
  _disownBrand() {
    return disown(this.brand);
  }
  get brand() {
    return getStruct(0, Brand, this);
  }
  _hasBrand() {
    return !isNull(getPointer(0, this));
  }
  _initBrand() {
    return initStructAt(0, Brand, this);
  }
  set brand(value) {
    copyFrom(value, getPointer(0, this));
  }
  toString() {
    return "Type_Struct_" + super.toString();
  }
}
class Type_Interface extends Struct {
  static _capnp = {
    displayName: "interface",
    id: "ed8bca69f7fb0cbf",
    typeId: 0xed8bca69f7fb0cbfn,
    typeIdHex: "ed8bca69f7fb0cbf",
    size: new ObjectSize(24, 1),
    fields: [
      { name: "typeId", codeOrder: 0, ordinal: 17, kind: "slot", offset: 1, type: { kind: "uint64" } },
      { name: "brand", codeOrder: 1, ordinal: 23, kind: "slot", offset: 0, type: { kind: "struct", typeId: 0x903455f06065422bn, typeIdHex: "903455f06065422b", displayName: "Brand" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["typeId"];
      if (value2 !== void 0) {
        target.typeId = value2;
      }
    }
    {
      const value2 = init["brand"];
      if (value2 !== void 0) {
        if (value2 instanceof Brand) {
          target.brand = value2;
        } else {
          Brand._applyInit(target._initBrand(), value2);
        }
      }
    }
  }
  get typeId() {
    return getUint64(8, this);
  }
  set typeId(value) {
    setUint64(8, value, this);
  }
  _adoptBrand(value) {
    adopt(value, getPointer(0, this));
  }
  _disownBrand() {
    return disown(this.brand);
  }
  get brand() {
    return getStruct(0, Brand, this);
  }
  _hasBrand() {
    return !isNull(getPointer(0, this));
  }
  _initBrand() {
    return initStructAt(0, Brand, this);
  }
  set brand(value) {
    copyFrom(value, getPointer(0, this));
  }
  toString() {
    return "Type_Interface_" + super.toString();
  }
}
const Type_AnyPointer_Unconstrained_Which = {
  /**
  * truly AnyPointer
  *
  */
  ANY_KIND: 0,
  /**
  * AnyStruct
  *
  */
  STRUCT: 1,
  /**
  * AnyList
  *
  */
  LIST: 2,
  /**
  * Capability
  *
  */
  CAPABILITY: 3
};
class Type_AnyPointer_Unconstrained extends Struct {
  static ANY_KIND = Type_AnyPointer_Unconstrained_Which.ANY_KIND;
  static STRUCT = Type_AnyPointer_Unconstrained_Which.STRUCT;
  static LIST = Type_AnyPointer_Unconstrained_Which.LIST;
  static CAPABILITY = Type_AnyPointer_Unconstrained_Which.CAPABILITY;
  static _capnp = {
    displayName: "unconstrained",
    id: "8e3b5f79fe593656",
    typeId: 0x8e3b5f79fe593656n,
    typeIdHex: "8e3b5f79fe593656",
    size: new ObjectSize(24, 1),
    fields: [
      { name: "anyKind", codeOrder: 0, ordinal: 18, discriminantValue: 0, kind: "slot", offset: 0, type: { kind: "void" } },
      { name: "struct", codeOrder: 1, ordinal: 25, discriminantValue: 1, kind: "slot", offset: 0, type: { kind: "void" } },
      { name: "list", codeOrder: 2, ordinal: 26, discriminantValue: 2, kind: "slot", offset: 0, type: { kind: "void" } },
      { name: "capability", codeOrder: 3, ordinal: 27, discriminantValue: 3, kind: "slot", offset: 0, type: { kind: "void" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["anyKind"];
      if (value2 !== void 0) {
        target.anyKind = true;
      }
    }
    {
      const value2 = init["struct"];
      if (value2 !== void 0) {
        target.struct = true;
      }
    }
    {
      const value2 = init["list"];
      if (value2 !== void 0) {
        target.list = true;
      }
    }
    {
      const value2 = init["capability"];
      if (value2 !== void 0) {
        target.capability = true;
      }
    }
  }
  get _isAnyKind() {
    return getUint16(10, this) === 0;
  }
  set anyKind(_) {
    setUint16(10, 0, this);
  }
  get _isStruct() {
    return getUint16(10, this) === 1;
  }
  set struct(_) {
    setUint16(10, 1, this);
  }
  get _isList() {
    return getUint16(10, this) === 2;
  }
  set list(_) {
    setUint16(10, 2, this);
  }
  get _isCapability() {
    return getUint16(10, this) === 3;
  }
  set capability(_) {
    setUint16(10, 3, this);
  }
  toString() {
    return "Type_AnyPointer_Unconstrained_" + super.toString();
  }
  which() {
    return getUint16(10, this);
  }
  _set(value) {
    switch (value.which) {
      case "anyKind": {
        this.anyKind = true;
        return;
      }
      case "struct": {
        this.struct = true;
        return;
      }
      case "list": {
        this.list = true;
        return;
      }
      case "capability": {
        this.capability = true;
        return;
      }
    }
  }
  _match(cases) {
    const which = this.which();
    switch (which) {
      case 0: {
        const callback = cases["anyKind"];
        if (callback) {
          return callback();
        }
        break;
      }
      case 1: {
        const callback = cases["struct"];
        if (callback) {
          return callback();
        }
        break;
      }
      case 2: {
        const callback = cases["list"];
        if (callback) {
          return callback();
        }
        break;
      }
      case 3: {
        const callback = cases["capability"];
        if (callback) {
          return callback();
        }
        break;
      }
    }
    if (cases._) {
      return cases._(which);
    }
    throw new Error("Unhandled Type_AnyPointer_Unconstrained union case: " + which);
  }
}
class Type_AnyPointer_Parameter extends Struct {
  static _capnp = {
    displayName: "parameter",
    id: "9dd1f724f4614a85",
    typeId: 0x9dd1f724f4614a85n,
    typeIdHex: "9dd1f724f4614a85",
    size: new ObjectSize(24, 1),
    fields: [
      { name: "scopeId", codeOrder: 0, ordinal: 19, kind: "slot", offset: 2, type: { kind: "uint64" } },
      { name: "parameterIndex", codeOrder: 1, ordinal: 20, kind: "slot", offset: 5, type: { kind: "uint16" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["scopeId"];
      if (value2 !== void 0) {
        target.scopeId = value2;
      }
    }
    {
      const value2 = init["parameterIndex"];
      if (value2 !== void 0) {
        target.parameterIndex = value2;
      }
    }
  }
  /**
  * ID of the generic type whose parameter we're referencing. This should be a parent of the
  * current scope.
  *
  */
  get scopeId() {
    return getUint64(16, this);
  }
  set scopeId(value) {
    setUint64(16, value, this);
  }
  /**
  * Index of the parameter within the generic type's parameter list.
  *
  */
  get parameterIndex() {
    return getUint16(10, this);
  }
  set parameterIndex(value) {
    setUint16(10, value, this);
  }
  toString() {
    return "Type_AnyPointer_Parameter_" + super.toString();
  }
}
class Type_AnyPointer_ImplicitMethodParameter extends Struct {
  static _capnp = {
    displayName: "implicitMethodParameter",
    id: "baefc9120c56e274",
    typeId: 0xbaefc9120c56e274n,
    typeIdHex: "baefc9120c56e274",
    size: new ObjectSize(24, 1),
    fields: [
      { name: "parameterIndex", codeOrder: 0, ordinal: 24, kind: "slot", offset: 5, type: { kind: "uint16" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["parameterIndex"];
      if (value2 !== void 0) {
        target.parameterIndex = value2;
      }
    }
  }
  get parameterIndex() {
    return getUint16(10, this);
  }
  set parameterIndex(value) {
    setUint16(10, value, this);
  }
  toString() {
    return "Type_AnyPointer_ImplicitMethodParameter_" + super.toString();
  }
}
const Type_AnyPointer_Which = {
  /**
  * A regular AnyPointer.
  *
  * The name "unconstrained" means as opposed to constraining it to match a type parameter.
  * In retrospect this name is probably a poor choice given that it may still be constrained
  * to be a struct, list, or capability.
  *
  */
  UNCONSTRAINED: 0,
  /**
  * This is actually a reference to a type parameter defined within this scope.
  *
  */
  PARAMETER: 1,
  /**
  * This is actually a reference to an implicit (generic) parameter of a method. The only
  * legal context for this type to appear is inside Method.paramBrand or Method.resultBrand.
  *
  */
  IMPLICIT_METHOD_PARAMETER: 2
};
class Type_AnyPointer extends Struct {
  static UNCONSTRAINED = Type_AnyPointer_Which.UNCONSTRAINED;
  static PARAMETER = Type_AnyPointer_Which.PARAMETER;
  static IMPLICIT_METHOD_PARAMETER = Type_AnyPointer_Which.IMPLICIT_METHOD_PARAMETER;
  static _capnp = {
    displayName: "anyPointer",
    id: "c2573fe8a23e49f1",
    typeId: 0xc2573fe8a23e49f1n,
    typeIdHex: "c2573fe8a23e49f1",
    size: new ObjectSize(24, 1),
    fields: [
      { name: "unconstrained", codeOrder: 0, ordinal: 0, discriminantValue: 0, kind: "group", type: { kind: "group", typeId: 0x8e3b5f79fe593656n, typeIdHex: "8e3b5f79fe593656", displayName: "unconstrained" } },
      { name: "parameter", codeOrder: 1, ordinal: 1, discriminantValue: 1, kind: "group", type: { kind: "group", typeId: 0x9dd1f724f4614a85n, typeIdHex: "9dd1f724f4614a85", displayName: "parameter" } },
      { name: "implicitMethodParameter", codeOrder: 2, ordinal: 2, discriminantValue: 2, kind: "group", type: { kind: "group", typeId: 0xbaefc9120c56e274n, typeIdHex: "baefc9120c56e274", displayName: "implicitMethodParameter" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["unconstrained"];
      if (value2 !== void 0) {
        Type_AnyPointer_Unconstrained._applyInit(target._initUnconstrained(), value2);
      }
    }
    {
      const value2 = init["parameter"];
      if (value2 !== void 0) {
        Type_AnyPointer_Parameter._applyInit(target._initParameter(), value2);
      }
    }
    {
      const value2 = init["implicitMethodParameter"];
      if (value2 !== void 0) {
        Type_AnyPointer_ImplicitMethodParameter._applyInit(target._initImplicitMethodParameter(), value2);
      }
    }
  }
  /**
  * A regular AnyPointer.
  *
  * The name "unconstrained" means as opposed to constraining it to match a type parameter.
  * In retrospect this name is probably a poor choice given that it may still be constrained
  * to be a struct, list, or capability.
  *
  */
  get unconstrained() {
    testWhich("unconstrained", getUint16(8, this), 0, this);
    return getAs(Type_AnyPointer_Unconstrained, this);
  }
  _initUnconstrained() {
    setUint16(8, 0, this);
    return getAs(Type_AnyPointer_Unconstrained, this);
  }
  get _isUnconstrained() {
    return getUint16(8, this) === 0;
  }
  set unconstrained(_) {
    setUint16(8, 0, this);
  }
  /**
  * This is actually a reference to a type parameter defined within this scope.
  *
  */
  get parameter() {
    testWhich("parameter", getUint16(8, this), 1, this);
    return getAs(Type_AnyPointer_Parameter, this);
  }
  _initParameter() {
    setUint16(8, 1, this);
    return getAs(Type_AnyPointer_Parameter, this);
  }
  get _isParameter() {
    return getUint16(8, this) === 1;
  }
  set parameter(_) {
    setUint16(8, 1, this);
  }
  /**
  * This is actually a reference to an implicit (generic) parameter of a method. The only
  * legal context for this type to appear is inside Method.paramBrand or Method.resultBrand.
  *
  */
  get implicitMethodParameter() {
    testWhich("implicitMethodParameter", getUint16(8, this), 2, this);
    return getAs(Type_AnyPointer_ImplicitMethodParameter, this);
  }
  _initImplicitMethodParameter() {
    setUint16(8, 2, this);
    return getAs(Type_AnyPointer_ImplicitMethodParameter, this);
  }
  get _isImplicitMethodParameter() {
    return getUint16(8, this) === 2;
  }
  set implicitMethodParameter(_) {
    setUint16(8, 2, this);
  }
  toString() {
    return "Type_AnyPointer_" + super.toString();
  }
  which() {
    return getUint16(8, this);
  }
  _set(value) {
    switch (value.which) {
      case "unconstrained": {
        this.unconstrained = true;
        return;
      }
      case "parameter": {
        this.parameter = true;
        return;
      }
      case "implicitMethodParameter": {
        this.implicitMethodParameter = true;
        return;
      }
    }
  }
  _match(cases) {
    const which = this.which();
    switch (which) {
      case 0: {
        const callback = cases["unconstrained"];
        if (callback) {
          return callback(this.unconstrained);
        }
        break;
      }
      case 1: {
        const callback = cases["parameter"];
        if (callback) {
          return callback(this.parameter);
        }
        break;
      }
      case 2: {
        const callback = cases["implicitMethodParameter"];
        if (callback) {
          return callback(this.implicitMethodParameter);
        }
        break;
      }
    }
    if (cases._) {
      return cases._(which);
    }
    throw new Error("Unhandled Type_AnyPointer union case: " + which);
  }
}
const Type_Which = {
  VOID: 0,
  BOOL: 1,
  INT8: 2,
  INT16: 3,
  INT32: 4,
  INT64: 5,
  UINT8: 6,
  UINT16: 7,
  UINT32: 8,
  UINT64: 9,
  FLOAT32: 10,
  FLOAT64: 11,
  TEXT: 12,
  DATA: 13,
  LIST: 14,
  ENUM: 15,
  STRUCT: 16,
  INTERFACE: 17,
  ANY_POINTER: 18
};
class Type extends Struct {
  static VOID = Type_Which.VOID;
  static BOOL = Type_Which.BOOL;
  static INT8 = Type_Which.INT8;
  static INT16 = Type_Which.INT16;
  static INT32 = Type_Which.INT32;
  static INT64 = Type_Which.INT64;
  static UINT8 = Type_Which.UINT8;
  static UINT16 = Type_Which.UINT16;
  static UINT32 = Type_Which.UINT32;
  static UINT64 = Type_Which.UINT64;
  static FLOAT32 = Type_Which.FLOAT32;
  static FLOAT64 = Type_Which.FLOAT64;
  static TEXT = Type_Which.TEXT;
  static DATA = Type_Which.DATA;
  static LIST = Type_Which.LIST;
  static ENUM = Type_Which.ENUM;
  static STRUCT = Type_Which.STRUCT;
  static INTERFACE = Type_Which.INTERFACE;
  static ANY_POINTER = Type_Which.ANY_POINTER;
  static _capnp = {
    displayName: "Type",
    id: "d07378ede1f9cc60",
    typeId: 0xd07378ede1f9cc60n,
    typeIdHex: "d07378ede1f9cc60",
    size: new ObjectSize(24, 1),
    fields: [
      { name: "void", codeOrder: 0, ordinal: 0, discriminantValue: 0, kind: "slot", offset: 0, type: { kind: "void" } },
      { name: "bool", codeOrder: 1, ordinal: 1, discriminantValue: 1, kind: "slot", offset: 0, type: { kind: "void" } },
      { name: "int8", codeOrder: 2, ordinal: 2, discriminantValue: 2, kind: "slot", offset: 0, type: { kind: "void" } },
      { name: "int16", codeOrder: 3, ordinal: 3, discriminantValue: 3, kind: "slot", offset: 0, type: { kind: "void" } },
      { name: "int32", codeOrder: 4, ordinal: 4, discriminantValue: 4, kind: "slot", offset: 0, type: { kind: "void" } },
      { name: "int64", codeOrder: 5, ordinal: 5, discriminantValue: 5, kind: "slot", offset: 0, type: { kind: "void" } },
      { name: "uint8", codeOrder: 6, ordinal: 6, discriminantValue: 6, kind: "slot", offset: 0, type: { kind: "void" } },
      { name: "uint16", codeOrder: 7, ordinal: 7, discriminantValue: 7, kind: "slot", offset: 0, type: { kind: "void" } },
      { name: "uint32", codeOrder: 8, ordinal: 8, discriminantValue: 8, kind: "slot", offset: 0, type: { kind: "void" } },
      { name: "uint64", codeOrder: 9, ordinal: 9, discriminantValue: 9, kind: "slot", offset: 0, type: { kind: "void" } },
      { name: "float32", codeOrder: 10, ordinal: 10, discriminantValue: 10, kind: "slot", offset: 0, type: { kind: "void" } },
      { name: "float64", codeOrder: 11, ordinal: 11, discriminantValue: 11, kind: "slot", offset: 0, type: { kind: "void" } },
      { name: "text", codeOrder: 12, ordinal: 12, discriminantValue: 12, kind: "slot", offset: 0, type: { kind: "void" } },
      { name: "data", codeOrder: 13, ordinal: 13, discriminantValue: 13, kind: "slot", offset: 0, type: { kind: "void" } },
      { name: "list", codeOrder: 14, ordinal: 14, discriminantValue: 14, kind: "group", type: { kind: "group", typeId: 0x87e739250a60ea97n, typeIdHex: "87e739250a60ea97", displayName: "list" } },
      { name: "enum", codeOrder: 15, ordinal: 15, discriminantValue: 15, kind: "group", type: { kind: "group", typeId: 0x9e0e78711a7f87a9n, typeIdHex: "9e0e78711a7f87a9", displayName: "enum" } },
      { name: "struct", codeOrder: 16, ordinal: 16, discriminantValue: 16, kind: "group", type: { kind: "group", typeId: 0xac3a6f60ef4cc6d3n, typeIdHex: "ac3a6f60ef4cc6d3", displayName: "struct" } },
      { name: "interface", codeOrder: 17, ordinal: 17, discriminantValue: 17, kind: "group", type: { kind: "group", typeId: 0xed8bca69f7fb0cbfn, typeIdHex: "ed8bca69f7fb0cbf", displayName: "interface" } },
      { name: "anyPointer", codeOrder: 18, ordinal: 18, discriminantValue: 18, kind: "group", type: { kind: "group", typeId: 0xc2573fe8a23e49f1n, typeIdHex: "c2573fe8a23e49f1", displayName: "anyPointer" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["void"];
      if (value2 !== void 0) {
        target.void = true;
      }
    }
    {
      const value2 = init["bool"];
      if (value2 !== void 0) {
        target.bool = true;
      }
    }
    {
      const value2 = init["int8"];
      if (value2 !== void 0) {
        target.int8 = true;
      }
    }
    {
      const value2 = init["int16"];
      if (value2 !== void 0) {
        target.int16 = true;
      }
    }
    {
      const value2 = init["int32"];
      if (value2 !== void 0) {
        target.int32 = true;
      }
    }
    {
      const value2 = init["int64"];
      if (value2 !== void 0) {
        target.int64 = true;
      }
    }
    {
      const value2 = init["uint8"];
      if (value2 !== void 0) {
        target.uint8 = true;
      }
    }
    {
      const value2 = init["uint16"];
      if (value2 !== void 0) {
        target.uint16 = true;
      }
    }
    {
      const value2 = init["uint32"];
      if (value2 !== void 0) {
        target.uint32 = true;
      }
    }
    {
      const value2 = init["uint64"];
      if (value2 !== void 0) {
        target.uint64 = true;
      }
    }
    {
      const value2 = init["float32"];
      if (value2 !== void 0) {
        target.float32 = true;
      }
    }
    {
      const value2 = init["float64"];
      if (value2 !== void 0) {
        target.float64 = true;
      }
    }
    {
      const value2 = init["text"];
      if (value2 !== void 0) {
        target.text = true;
      }
    }
    {
      const value2 = init["data"];
      if (value2 !== void 0) {
        target.data = true;
      }
    }
    {
      const value2 = init["list"];
      if (value2 !== void 0) {
        Type_List._applyInit(target._initList(), value2);
      }
    }
    {
      const value2 = init["enum"];
      if (value2 !== void 0) {
        Type_Enum._applyInit(target._initEnum(), value2);
      }
    }
    {
      const value2 = init["struct"];
      if (value2 !== void 0) {
        Type_Struct._applyInit(target._initStruct(), value2);
      }
    }
    {
      const value2 = init["interface"];
      if (value2 !== void 0) {
        Type_Interface._applyInit(target._initInterface(), value2);
      }
    }
    {
      const value2 = init["anyPointer"];
      if (value2 !== void 0) {
        Type_AnyPointer._applyInit(target._initAnyPointer(), value2);
      }
    }
  }
  get _isVoid() {
    return getUint16(0, this) === 0;
  }
  set void(_) {
    setUint16(0, 0, this);
  }
  get _isBool() {
    return getUint16(0, this) === 1;
  }
  set bool(_) {
    setUint16(0, 1, this);
  }
  get _isInt8() {
    return getUint16(0, this) === 2;
  }
  set int8(_) {
    setUint16(0, 2, this);
  }
  get _isInt16() {
    return getUint16(0, this) === 3;
  }
  set int16(_) {
    setUint16(0, 3, this);
  }
  get _isInt32() {
    return getUint16(0, this) === 4;
  }
  set int32(_) {
    setUint16(0, 4, this);
  }
  get _isInt64() {
    return getUint16(0, this) === 5;
  }
  set int64(_) {
    setUint16(0, 5, this);
  }
  get _isUint8() {
    return getUint16(0, this) === 6;
  }
  set uint8(_) {
    setUint16(0, 6, this);
  }
  get _isUint16() {
    return getUint16(0, this) === 7;
  }
  set uint16(_) {
    setUint16(0, 7, this);
  }
  get _isUint32() {
    return getUint16(0, this) === 8;
  }
  set uint32(_) {
    setUint16(0, 8, this);
  }
  get _isUint64() {
    return getUint16(0, this) === 9;
  }
  set uint64(_) {
    setUint16(0, 9, this);
  }
  get _isFloat32() {
    return getUint16(0, this) === 10;
  }
  set float32(_) {
    setUint16(0, 10, this);
  }
  get _isFloat64() {
    return getUint16(0, this) === 11;
  }
  set float64(_) {
    setUint16(0, 11, this);
  }
  get _isText() {
    return getUint16(0, this) === 12;
  }
  set text(_) {
    setUint16(0, 12, this);
  }
  get _isData() {
    return getUint16(0, this) === 13;
  }
  set data(_) {
    setUint16(0, 13, this);
  }
  get list() {
    testWhich("list", getUint16(0, this), 14, this);
    return getAs(Type_List, this);
  }
  _initList() {
    setUint16(0, 14, this);
    return getAs(Type_List, this);
  }
  get _isList() {
    return getUint16(0, this) === 14;
  }
  set list(_) {
    setUint16(0, 14, this);
  }
  get enum() {
    testWhich("enum", getUint16(0, this), 15, this);
    return getAs(Type_Enum, this);
  }
  _initEnum() {
    setUint16(0, 15, this);
    return getAs(Type_Enum, this);
  }
  get _isEnum() {
    return getUint16(0, this) === 15;
  }
  set enum(_) {
    setUint16(0, 15, this);
  }
  get struct() {
    testWhich("struct", getUint16(0, this), 16, this);
    return getAs(Type_Struct, this);
  }
  _initStruct() {
    setUint16(0, 16, this);
    return getAs(Type_Struct, this);
  }
  get _isStruct() {
    return getUint16(0, this) === 16;
  }
  set struct(_) {
    setUint16(0, 16, this);
  }
  get interface() {
    testWhich("interface", getUint16(0, this), 17, this);
    return getAs(Type_Interface, this);
  }
  _initInterface() {
    setUint16(0, 17, this);
    return getAs(Type_Interface, this);
  }
  get _isInterface() {
    return getUint16(0, this) === 17;
  }
  set interface(_) {
    setUint16(0, 17, this);
  }
  get anyPointer() {
    testWhich("anyPointer", getUint16(0, this), 18, this);
    return getAs(Type_AnyPointer, this);
  }
  _initAnyPointer() {
    setUint16(0, 18, this);
    return getAs(Type_AnyPointer, this);
  }
  get _isAnyPointer() {
    return getUint16(0, this) === 18;
  }
  set anyPointer(_) {
    setUint16(0, 18, this);
  }
  toString() {
    return "Type_" + super.toString();
  }
  which() {
    return getUint16(0, this);
  }
  _set(value) {
    switch (value.which) {
      case "void": {
        this.void = true;
        return;
      }
      case "bool": {
        this.bool = true;
        return;
      }
      case "int8": {
        this.int8 = true;
        return;
      }
      case "int16": {
        this.int16 = true;
        return;
      }
      case "int32": {
        this.int32 = true;
        return;
      }
      case "int64": {
        this.int64 = true;
        return;
      }
      case "uint8": {
        this.uint8 = true;
        return;
      }
      case "uint16": {
        this.uint16 = true;
        return;
      }
      case "uint32": {
        this.uint32 = true;
        return;
      }
      case "uint64": {
        this.uint64 = true;
        return;
      }
      case "float32": {
        this.float32 = true;
        return;
      }
      case "float64": {
        this.float64 = true;
        return;
      }
      case "text": {
        this.text = true;
        return;
      }
      case "data": {
        this.data = true;
        return;
      }
      case "list": {
        this.list = true;
        return;
      }
      case "enum": {
        this.enum = true;
        return;
      }
      case "struct": {
        this.struct = true;
        return;
      }
      case "interface": {
        this.interface = true;
        return;
      }
      case "anyPointer": {
        this.anyPointer = true;
        return;
      }
    }
  }
  _match(cases) {
    const which = this.which();
    switch (which) {
      case 0: {
        const callback = cases["void"];
        if (callback) {
          return callback();
        }
        break;
      }
      case 1: {
        const callback = cases["bool"];
        if (callback) {
          return callback();
        }
        break;
      }
      case 2: {
        const callback = cases["int8"];
        if (callback) {
          return callback();
        }
        break;
      }
      case 3: {
        const callback = cases["int16"];
        if (callback) {
          return callback();
        }
        break;
      }
      case 4: {
        const callback = cases["int32"];
        if (callback) {
          return callback();
        }
        break;
      }
      case 5: {
        const callback = cases["int64"];
        if (callback) {
          return callback();
        }
        break;
      }
      case 6: {
        const callback = cases["uint8"];
        if (callback) {
          return callback();
        }
        break;
      }
      case 7: {
        const callback = cases["uint16"];
        if (callback) {
          return callback();
        }
        break;
      }
      case 8: {
        const callback = cases["uint32"];
        if (callback) {
          return callback();
        }
        break;
      }
      case 9: {
        const callback = cases["uint64"];
        if (callback) {
          return callback();
        }
        break;
      }
      case 10: {
        const callback = cases["float32"];
        if (callback) {
          return callback();
        }
        break;
      }
      case 11: {
        const callback = cases["float64"];
        if (callback) {
          return callback();
        }
        break;
      }
      case 12: {
        const callback = cases["text"];
        if (callback) {
          return callback();
        }
        break;
      }
      case 13: {
        const callback = cases["data"];
        if (callback) {
          return callback();
        }
        break;
      }
      case 14: {
        const callback = cases["list"];
        if (callback) {
          return callback(this.list);
        }
        break;
      }
      case 15: {
        const callback = cases["enum"];
        if (callback) {
          return callback(this.enum);
        }
        break;
      }
      case 16: {
        const callback = cases["struct"];
        if (callback) {
          return callback(this.struct);
        }
        break;
      }
      case 17: {
        const callback = cases["interface"];
        if (callback) {
          return callback(this.interface);
        }
        break;
      }
      case 18: {
        const callback = cases["anyPointer"];
        if (callback) {
          return callback(this.anyPointer);
        }
        break;
      }
    }
    if (cases._) {
      return cases._(which);
    }
    throw new Error("Unhandled Type union case: " + which);
  }
}
const Brand_Scope_Which = {
  /**
  * ID of the scope to which these params apply.
  *
  */
  BIND: 0,
  /**
  * List of parameter bindings.
  *
  */
  INHERIT: 1
};
class Brand_Scope extends Struct {
  static BIND = Brand_Scope_Which.BIND;
  static INHERIT = Brand_Scope_Which.INHERIT;
  static _capnp = {
    displayName: "Scope",
    id: "abd73485a9636bc9",
    typeId: 0xabd73485a9636bc9n,
    typeIdHex: "abd73485a9636bc9",
    size: new ObjectSize(16, 1),
    fields: [
      { name: "scopeId", codeOrder: 0, ordinal: 0, kind: "slot", offset: 0, type: { kind: "uint64" } },
      { name: "bind", codeOrder: 1, ordinal: 1, discriminantValue: 0, kind: "slot", offset: 0, type: { kind: "list", elementType: { kind: "struct", typeId: 0xc863cd16969ee7fcn, typeIdHex: "c863cd16969ee7fc", displayName: "Binding" } } },
      { name: "inherit", codeOrder: 2, ordinal: 2, discriminantValue: 1, kind: "slot", offset: 0, type: { kind: "void" } }
    ]
  };
  static _Bind;
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["scopeId"];
      if (value2 !== void 0) {
        target.scopeId = value2;
      }
    }
    {
      const value2 = init["bind"];
      if (value2 !== void 0) {
        if (value2 instanceof List) {
          target.bind = value2;
        } else {
          const values = Array.isArray(value2) ? value2 : Array.from(value2);
          const list = target._initBind(values.length);
          for (let index = 0; index < values.length; index++) {
            const item = values[index];
            if (item instanceof Brand_Binding) {
              list.set(index, item);
            } else {
              Brand_Binding._applyInit(list.get(index), item);
            }
          }
        }
      }
    }
    {
      const value2 = init["inherit"];
      if (value2 !== void 0) {
        target.inherit = true;
      }
    }
  }
  /**
  * ID of the scope to which these params apply.
  *
  */
  get scopeId() {
    return getUint64(0, this);
  }
  set scopeId(value) {
    setUint64(0, value, this);
  }
  _adoptBind(value) {
    setUint16(8, 0, this);
    adopt(value, getPointer(0, this));
  }
  _disownBind() {
    return disown(this.bind);
  }
  /**
  * List of parameter bindings.
  *
  */
  get bind() {
    testWhich("bind", getUint16(8, this), 0, this);
    return getList(0, Brand_Scope._Bind, this);
  }
  _hasBind() {
    return !isNull(getPointer(0, this));
  }
  _initBind(length) {
    setUint16(8, 0, this);
    return initList(0, Brand_Scope._Bind, length, this);
  }
  get _isBind() {
    return getUint16(8, this) === 0;
  }
  set bind(value) {
    setUint16(8, 0, this);
    copyFrom(value, getPointer(0, this));
  }
  get _isInherit() {
    return getUint16(8, this) === 1;
  }
  set inherit(_) {
    setUint16(8, 1, this);
  }
  toString() {
    return "Brand_Scope_" + super.toString();
  }
  which() {
    return getUint16(8, this);
  }
  _set(value) {
    switch (value.which) {
      case "bind": {
        this.bind = value.value;
        return;
      }
      case "inherit": {
        this.inherit = true;
        return;
      }
    }
  }
  _match(cases) {
    const which = this.which();
    switch (which) {
      case 0: {
        const callback = cases["bind"];
        if (callback) {
          return callback(this.bind);
        }
        break;
      }
      case 1: {
        const callback = cases["inherit"];
        if (callback) {
          return callback();
        }
        break;
      }
    }
    if (cases._) {
      return cases._(which);
    }
    throw new Error("Unhandled Brand_Scope union case: " + which);
  }
}
const Brand_Binding_Which = {
  UNBOUND: 0,
  TYPE: 1
};
class Brand_Binding extends Struct {
  static UNBOUND = Brand_Binding_Which.UNBOUND;
  static TYPE = Brand_Binding_Which.TYPE;
  static _capnp = {
    displayName: "Binding",
    id: "c863cd16969ee7fc",
    typeId: 0xc863cd16969ee7fcn,
    typeIdHex: "c863cd16969ee7fc",
    size: new ObjectSize(8, 1),
    fields: [
      { name: "unbound", codeOrder: 0, ordinal: 0, discriminantValue: 0, kind: "slot", offset: 0, type: { kind: "void" } },
      { name: "type", codeOrder: 1, ordinal: 1, discriminantValue: 1, kind: "slot", offset: 0, type: { kind: "struct", typeId: 0xd07378ede1f9cc60n, typeIdHex: "d07378ede1f9cc60", displayName: "Type" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["unbound"];
      if (value2 !== void 0) {
        target.unbound = true;
      }
    }
    {
      const value2 = init["type"];
      if (value2 !== void 0) {
        if (value2 instanceof Type) {
          target.type = value2;
        } else {
          Type._applyInit(target._initType(), value2);
        }
      }
    }
  }
  get _isUnbound() {
    return getUint16(0, this) === 0;
  }
  set unbound(_) {
    setUint16(0, 0, this);
  }
  _adoptType(value) {
    setUint16(0, 1, this);
    adopt(value, getPointer(0, this));
  }
  _disownType() {
    return disown(this.type);
  }
  get type() {
    testWhich("type", getUint16(0, this), 1, this);
    return getStruct(0, Type, this);
  }
  _hasType() {
    return !isNull(getPointer(0, this));
  }
  _initType() {
    setUint16(0, 1, this);
    return initStructAt(0, Type, this);
  }
  get _isType() {
    return getUint16(0, this) === 1;
  }
  set type(value) {
    setUint16(0, 1, this);
    copyFrom(value, getPointer(0, this));
  }
  toString() {
    return "Brand_Binding_" + super.toString();
  }
  which() {
    return getUint16(0, this);
  }
  _set(value) {
    switch (value.which) {
      case "unbound": {
        this.unbound = true;
        return;
      }
      case "type": {
        this.type = value.value;
        return;
      }
    }
  }
  _match(cases) {
    const which = this.which();
    switch (which) {
      case 0: {
        const callback = cases["unbound"];
        if (callback) {
          return callback();
        }
        break;
      }
      case 1: {
        const callback = cases["type"];
        if (callback) {
          return callback(this.type);
        }
        break;
      }
    }
    if (cases._) {
      return cases._(which);
    }
    throw new Error("Unhandled Brand_Binding union case: " + which);
  }
}
class Brand extends Struct {
  static Scope = Brand_Scope;
  static Binding = Brand_Binding;
  static _capnp = {
    displayName: "Brand",
    id: "903455f06065422b",
    typeId: 0x903455f06065422bn,
    typeIdHex: "903455f06065422b",
    size: new ObjectSize(0, 1),
    fields: [
      { name: "scopes", codeOrder: 0, ordinal: 0, kind: "slot", offset: 0, type: { kind: "list", elementType: { kind: "struct", typeId: 0xabd73485a9636bc9n, typeIdHex: "abd73485a9636bc9", displayName: "Scope" } } }
    ]
  };
  static _Scopes;
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["scopes"];
      if (value2 !== void 0) {
        if (value2 instanceof List) {
          target.scopes = value2;
        } else {
          const values = Array.isArray(value2) ? value2 : Array.from(value2);
          const list = target._initScopes(values.length);
          for (let index = 0; index < values.length; index++) {
            const item = values[index];
            if (item instanceof Brand_Scope) {
              list.set(index, item);
            } else {
              Brand_Scope._applyInit(list.get(index), item);
            }
          }
        }
      }
    }
  }
  _adoptScopes(value) {
    adopt(value, getPointer(0, this));
  }
  _disownScopes() {
    return disown(this.scopes);
  }
  /**
  * For each of the target type and each of its parent scopes, a parameterization may be included
  * in this list. If no parameterization is included for a particular relevant scope, then either
  * that scope has no parameters or all parameters should be considered to be `AnyPointer`.
  *
  */
  get scopes() {
    return getList(0, Brand._Scopes, this);
  }
  _hasScopes() {
    return !isNull(getPointer(0, this));
  }
  _initScopes(length) {
    return initList(0, Brand._Scopes, length, this);
  }
  set scopes(value) {
    copyFrom(value, getPointer(0, this));
  }
  toString() {
    return "Brand_" + super.toString();
  }
}
const Value_Which = {
  VOID: 0,
  BOOL: 1,
  INT8: 2,
  INT16: 3,
  INT32: 4,
  INT64: 5,
  UINT8: 6,
  UINT16: 7,
  UINT32: 8,
  UINT64: 9,
  FLOAT32: 10,
  FLOAT64: 11,
  TEXT: 12,
  DATA: 13,
  LIST: 14,
  ENUM: 15,
  STRUCT: 16,
  /**
  * The only interface value that can be represented statically is "null", whose methods always
  * throw exceptions.
  *
  */
  INTERFACE: 17,
  ANY_POINTER: 18
};
class Value extends Struct {
  static VOID = Value_Which.VOID;
  static BOOL = Value_Which.BOOL;
  static INT8 = Value_Which.INT8;
  static INT16 = Value_Which.INT16;
  static INT32 = Value_Which.INT32;
  static INT64 = Value_Which.INT64;
  static UINT8 = Value_Which.UINT8;
  static UINT16 = Value_Which.UINT16;
  static UINT32 = Value_Which.UINT32;
  static UINT64 = Value_Which.UINT64;
  static FLOAT32 = Value_Which.FLOAT32;
  static FLOAT64 = Value_Which.FLOAT64;
  static TEXT = Value_Which.TEXT;
  static DATA = Value_Which.DATA;
  static LIST = Value_Which.LIST;
  static ENUM = Value_Which.ENUM;
  static STRUCT = Value_Which.STRUCT;
  static INTERFACE = Value_Which.INTERFACE;
  static ANY_POINTER = Value_Which.ANY_POINTER;
  static _capnp = {
    displayName: "Value",
    id: "ce23dcd2d7b00c9b",
    typeId: 0xce23dcd2d7b00c9bn,
    typeIdHex: "ce23dcd2d7b00c9b",
    size: new ObjectSize(16, 1),
    fields: [
      { name: "void", codeOrder: 0, ordinal: 0, discriminantValue: 0, kind: "slot", offset: 0, type: { kind: "void" } },
      { name: "bool", codeOrder: 1, ordinal: 1, discriminantValue: 1, kind: "slot", offset: 16, type: { kind: "bool" } },
      { name: "int8", codeOrder: 2, ordinal: 2, discriminantValue: 2, kind: "slot", offset: 2, type: { kind: "int8" } },
      { name: "int16", codeOrder: 3, ordinal: 3, discriminantValue: 3, kind: "slot", offset: 1, type: { kind: "int16" } },
      { name: "int32", codeOrder: 4, ordinal: 4, discriminantValue: 4, kind: "slot", offset: 1, type: { kind: "int32" } },
      { name: "int64", codeOrder: 5, ordinal: 5, discriminantValue: 5, kind: "slot", offset: 1, type: { kind: "int64" } },
      { name: "uint8", codeOrder: 6, ordinal: 6, discriminantValue: 6, kind: "slot", offset: 2, type: { kind: "uint8" } },
      { name: "uint16", codeOrder: 7, ordinal: 7, discriminantValue: 7, kind: "slot", offset: 1, type: { kind: "uint16" } },
      { name: "uint32", codeOrder: 8, ordinal: 8, discriminantValue: 8, kind: "slot", offset: 1, type: { kind: "uint32" } },
      { name: "uint64", codeOrder: 9, ordinal: 9, discriminantValue: 9, kind: "slot", offset: 1, type: { kind: "uint64" } },
      { name: "float32", codeOrder: 10, ordinal: 10, discriminantValue: 10, kind: "slot", offset: 1, type: { kind: "float32" } },
      { name: "float64", codeOrder: 11, ordinal: 11, discriminantValue: 11, kind: "slot", offset: 1, type: { kind: "float64" } },
      { name: "text", codeOrder: 12, ordinal: 12, discriminantValue: 12, kind: "slot", offset: 0, type: { kind: "text" } },
      { name: "data", codeOrder: 13, ordinal: 13, discriminantValue: 13, kind: "slot", offset: 0, type: { kind: "data" } },
      { name: "list", codeOrder: 14, ordinal: 14, discriminantValue: 14, kind: "slot", offset: 0, type: { kind: "anyPointer" } },
      { name: "enum", codeOrder: 15, ordinal: 15, discriminantValue: 15, kind: "slot", offset: 1, type: { kind: "uint16" } },
      { name: "struct", codeOrder: 16, ordinal: 16, discriminantValue: 16, kind: "slot", offset: 0, type: { kind: "anyPointer" } },
      { name: "interface", codeOrder: 17, ordinal: 17, discriminantValue: 17, kind: "slot", offset: 0, type: { kind: "void" } },
      { name: "anyPointer", codeOrder: 18, ordinal: 18, discriminantValue: 18, kind: "slot", offset: 0, type: { kind: "anyPointer" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["void"];
      if (value2 !== void 0) {
        target.void = true;
      }
    }
    {
      const value2 = init["bool"];
      if (value2 !== void 0) {
        target.bool = value2;
      }
    }
    {
      const value2 = init["int8"];
      if (value2 !== void 0) {
        target.int8 = value2;
      }
    }
    {
      const value2 = init["int16"];
      if (value2 !== void 0) {
        target.int16 = value2;
      }
    }
    {
      const value2 = init["int32"];
      if (value2 !== void 0) {
        target.int32 = value2;
      }
    }
    {
      const value2 = init["int64"];
      if (value2 !== void 0) {
        target.int64 = value2;
      }
    }
    {
      const value2 = init["uint8"];
      if (value2 !== void 0) {
        target.uint8 = value2;
      }
    }
    {
      const value2 = init["uint16"];
      if (value2 !== void 0) {
        target.uint16 = value2;
      }
    }
    {
      const value2 = init["uint32"];
      if (value2 !== void 0) {
        target.uint32 = value2;
      }
    }
    {
      const value2 = init["uint64"];
      if (value2 !== void 0) {
        target.uint64 = value2;
      }
    }
    {
      const value2 = init["float32"];
      if (value2 !== void 0) {
        target.float32 = value2;
      }
    }
    {
      const value2 = init["float64"];
      if (value2 !== void 0) {
        target.float64 = value2;
      }
    }
    {
      const value2 = init["text"];
      if (value2 !== void 0) {
        target.text = value2;
      }
    }
    {
      const value2 = init["data"];
      if (value2 !== void 0) {
        if (value2 instanceof Data) {
          target.data = value2;
        } else {
          const bytes = dataBytes(value2);
          target._initData(bytes.byteLength).copyBuffer(bytes);
        }
      }
    }
    {
      const value2 = init["list"];
      if (value2 !== void 0) {
        target.list = value2;
      }
    }
    {
      const value2 = init["enum"];
      if (value2 !== void 0) {
        target.enum = value2;
      }
    }
    {
      const value2 = init["struct"];
      if (value2 !== void 0) {
        target.struct = value2;
      }
    }
    {
      const value2 = init["interface"];
      if (value2 !== void 0) {
        target.interface = true;
      }
    }
    {
      const value2 = init["anyPointer"];
      if (value2 !== void 0) {
        target.anyPointer = value2;
      }
    }
  }
  get _isVoid() {
    return getUint16(0, this) === 0;
  }
  set void(_) {
    setUint16(0, 0, this);
  }
  get bool() {
    testWhich("bool", getUint16(0, this), 1, this);
    return getBit(16, this);
  }
  get _isBool() {
    return getUint16(0, this) === 1;
  }
  set bool(value) {
    setUint16(0, 1, this);
    setBit(16, value, this);
  }
  get int8() {
    testWhich("int8", getUint16(0, this), 2, this);
    return getInt8(2, this);
  }
  get _isInt8() {
    return getUint16(0, this) === 2;
  }
  set int8(value) {
    setUint16(0, 2, this);
    setInt8(2, value, this);
  }
  get int16() {
    testWhich("int16", getUint16(0, this), 3, this);
    return getInt16(2, this);
  }
  get _isInt16() {
    return getUint16(0, this) === 3;
  }
  set int16(value) {
    setUint16(0, 3, this);
    setInt16(2, value, this);
  }
  get int32() {
    testWhich("int32", getUint16(0, this), 4, this);
    return getInt32(4, this);
  }
  get _isInt32() {
    return getUint16(0, this) === 4;
  }
  set int32(value) {
    setUint16(0, 4, this);
    setInt32(4, value, this);
  }
  get int64() {
    testWhich("int64", getUint16(0, this), 5, this);
    return getInt64(8, this);
  }
  get _isInt64() {
    return getUint16(0, this) === 5;
  }
  set int64(value) {
    setUint16(0, 5, this);
    setInt64(8, value, this);
  }
  get uint8() {
    testWhich("uint8", getUint16(0, this), 6, this);
    return getUint8(2, this);
  }
  get _isUint8() {
    return getUint16(0, this) === 6;
  }
  set uint8(value) {
    setUint16(0, 6, this);
    setUint8(2, value, this);
  }
  get uint16() {
    testWhich("uint16", getUint16(0, this), 7, this);
    return getUint16(2, this);
  }
  get _isUint16() {
    return getUint16(0, this) === 7;
  }
  set uint16(value) {
    setUint16(0, 7, this);
    setUint16(2, value, this);
  }
  get uint32() {
    testWhich("uint32", getUint16(0, this), 8, this);
    return getUint32(4, this);
  }
  get _isUint32() {
    return getUint16(0, this) === 8;
  }
  set uint32(value) {
    setUint16(0, 8, this);
    setUint32(4, value, this);
  }
  get uint64() {
    testWhich("uint64", getUint16(0, this), 9, this);
    return getUint64(8, this);
  }
  get _isUint64() {
    return getUint16(0, this) === 9;
  }
  set uint64(value) {
    setUint16(0, 9, this);
    setUint64(8, value, this);
  }
  get float32() {
    testWhich("float32", getUint16(0, this), 10, this);
    return getFloat32(4, this);
  }
  get _isFloat32() {
    return getUint16(0, this) === 10;
  }
  set float32(value) {
    setUint16(0, 10, this);
    setFloat32(4, value, this);
  }
  get float64() {
    testWhich("float64", getUint16(0, this), 11, this);
    return getFloat64(8, this);
  }
  get _isFloat64() {
    return getUint16(0, this) === 11;
  }
  set float64(value) {
    setUint16(0, 11, this);
    setFloat64(8, value, this);
  }
  get text() {
    testWhich("text", getUint16(0, this), 12, this);
    return getText(0, this);
  }
  get _isText() {
    return getUint16(0, this) === 12;
  }
  set text(value) {
    setUint16(0, 12, this);
    setText(0, value, this);
  }
  _adoptData(value) {
    setUint16(0, 13, this);
    adopt(value, getPointer(0, this));
  }
  _disownData() {
    return disown(this.data);
  }
  get data() {
    testWhich("data", getUint16(0, this), 13, this);
    return getData(0, this);
  }
  _hasData() {
    return !isNull(getPointer(0, this));
  }
  _initData(length) {
    setUint16(0, 13, this);
    return initData(0, length, this);
  }
  get _isData() {
    return getUint16(0, this) === 13;
  }
  set data(value) {
    setUint16(0, 13, this);
    copyFrom(value, getPointer(0, this));
  }
  _adoptList(value) {
    setUint16(0, 14, this);
    adopt(value, getPointer(0, this));
  }
  _disownList() {
    return disown(this.list);
  }
  get list() {
    testWhich("list", getUint16(0, this), 14, this);
    return getPointer(0, this);
  }
  _hasList() {
    return !isNull(getPointer(0, this));
  }
  get _isList() {
    return getUint16(0, this) === 14;
  }
  set list(value) {
    setUint16(0, 14, this);
    copyFrom(value, getPointer(0, this));
  }
  get enum() {
    testWhich("enum", getUint16(0, this), 15, this);
    return getUint16(2, this);
  }
  get _isEnum() {
    return getUint16(0, this) === 15;
  }
  set enum(value) {
    setUint16(0, 15, this);
    setUint16(2, value, this);
  }
  _adoptStruct(value) {
    setUint16(0, 16, this);
    adopt(value, getPointer(0, this));
  }
  _disownStruct() {
    return disown(this.struct);
  }
  get struct() {
    testWhich("struct", getUint16(0, this), 16, this);
    return getPointer(0, this);
  }
  _hasStruct() {
    return !isNull(getPointer(0, this));
  }
  get _isStruct() {
    return getUint16(0, this) === 16;
  }
  set struct(value) {
    setUint16(0, 16, this);
    copyFrom(value, getPointer(0, this));
  }
  get _isInterface() {
    return getUint16(0, this) === 17;
  }
  set interface(_) {
    setUint16(0, 17, this);
  }
  _adoptAnyPointer(value) {
    setUint16(0, 18, this);
    adopt(value, getPointer(0, this));
  }
  _disownAnyPointer() {
    return disown(this.anyPointer);
  }
  get anyPointer() {
    testWhich("anyPointer", getUint16(0, this), 18, this);
    return getPointer(0, this);
  }
  _hasAnyPointer() {
    return !isNull(getPointer(0, this));
  }
  get _isAnyPointer() {
    return getUint16(0, this) === 18;
  }
  set anyPointer(value) {
    setUint16(0, 18, this);
    copyFrom(value, getPointer(0, this));
  }
  toString() {
    return "Value_" + super.toString();
  }
  which() {
    return getUint16(0, this);
  }
  _set(value) {
    switch (value.which) {
      case "void": {
        this.void = true;
        return;
      }
      case "bool": {
        this.bool = value.value;
        return;
      }
      case "int8": {
        this.int8 = value.value;
        return;
      }
      case "int16": {
        this.int16 = value.value;
        return;
      }
      case "int32": {
        this.int32 = value.value;
        return;
      }
      case "int64": {
        this.int64 = value.value;
        return;
      }
      case "uint8": {
        this.uint8 = value.value;
        return;
      }
      case "uint16": {
        this.uint16 = value.value;
        return;
      }
      case "uint32": {
        this.uint32 = value.value;
        return;
      }
      case "uint64": {
        this.uint64 = value.value;
        return;
      }
      case "float32": {
        this.float32 = value.value;
        return;
      }
      case "float64": {
        this.float64 = value.value;
        return;
      }
      case "text": {
        this.text = value.value;
        return;
      }
      case "data": {
        this.data = value.value;
        return;
      }
      case "list": {
        this.list = value.value;
        return;
      }
      case "enum": {
        this.enum = value.value;
        return;
      }
      case "struct": {
        this.struct = value.value;
        return;
      }
      case "interface": {
        this.interface = true;
        return;
      }
      case "anyPointer": {
        this.anyPointer = value.value;
        return;
      }
    }
  }
  _match(cases) {
    const which = this.which();
    switch (which) {
      case 0: {
        const callback = cases["void"];
        if (callback) {
          return callback();
        }
        break;
      }
      case 1: {
        const callback = cases["bool"];
        if (callback) {
          return callback(this.bool);
        }
        break;
      }
      case 2: {
        const callback = cases["int8"];
        if (callback) {
          return callback(this.int8);
        }
        break;
      }
      case 3: {
        const callback = cases["int16"];
        if (callback) {
          return callback(this.int16);
        }
        break;
      }
      case 4: {
        const callback = cases["int32"];
        if (callback) {
          return callback(this.int32);
        }
        break;
      }
      case 5: {
        const callback = cases["int64"];
        if (callback) {
          return callback(this.int64);
        }
        break;
      }
      case 6: {
        const callback = cases["uint8"];
        if (callback) {
          return callback(this.uint8);
        }
        break;
      }
      case 7: {
        const callback = cases["uint16"];
        if (callback) {
          return callback(this.uint16);
        }
        break;
      }
      case 8: {
        const callback = cases["uint32"];
        if (callback) {
          return callback(this.uint32);
        }
        break;
      }
      case 9: {
        const callback = cases["uint64"];
        if (callback) {
          return callback(this.uint64);
        }
        break;
      }
      case 10: {
        const callback = cases["float32"];
        if (callback) {
          return callback(this.float32);
        }
        break;
      }
      case 11: {
        const callback = cases["float64"];
        if (callback) {
          return callback(this.float64);
        }
        break;
      }
      case 12: {
        const callback = cases["text"];
        if (callback) {
          return callback(this.text);
        }
        break;
      }
      case 13: {
        const callback = cases["data"];
        if (callback) {
          return callback(this.data);
        }
        break;
      }
      case 14: {
        const callback = cases["list"];
        if (callback) {
          return callback(this.list);
        }
        break;
      }
      case 15: {
        const callback = cases["enum"];
        if (callback) {
          return callback(this.enum);
        }
        break;
      }
      case 16: {
        const callback = cases["struct"];
        if (callback) {
          return callback(this.struct);
        }
        break;
      }
      case 17: {
        const callback = cases["interface"];
        if (callback) {
          return callback();
        }
        break;
      }
      case 18: {
        const callback = cases["anyPointer"];
        if (callback) {
          return callback(this.anyPointer);
        }
        break;
      }
    }
    if (cases._) {
      return cases._(which);
    }
    throw new Error("Unhandled Value union case: " + which);
  }
}
class Annotation extends Struct {
  static _capnp = {
    displayName: "Annotation",
    id: "f1c8950dab257542",
    typeId: 0xf1c8950dab257542n,
    typeIdHex: "f1c8950dab257542",
    size: new ObjectSize(8, 2),
    fields: [
      { name: "id", codeOrder: 0, ordinal: 0, kind: "slot", offset: 0, type: { kind: "uint64" } },
      { name: "brand", codeOrder: 1, ordinal: 2, kind: "slot", offset: 1, type: { kind: "struct", typeId: 0x903455f06065422bn, typeIdHex: "903455f06065422b", displayName: "Brand" } },
      { name: "value", codeOrder: 2, ordinal: 1, kind: "slot", offset: 0, type: { kind: "struct", typeId: 0xce23dcd2d7b00c9bn, typeIdHex: "ce23dcd2d7b00c9b", displayName: "Value" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["id"];
      if (value2 !== void 0) {
        target.id = value2;
      }
    }
    {
      const value2 = init["brand"];
      if (value2 !== void 0) {
        if (value2 instanceof Brand) {
          target.brand = value2;
        } else {
          Brand._applyInit(target._initBrand(), value2);
        }
      }
    }
    {
      const value2 = init["value"];
      if (value2 !== void 0) {
        if (value2 instanceof Value) {
          target.value = value2;
        } else {
          Value._applyInit(target._initValue(), value2);
        }
      }
    }
  }
  /**
  * ID of the annotation node.
  *
  */
  get id() {
    return getUint64(0, this);
  }
  set id(value) {
    setUint64(0, value, this);
  }
  _adoptBrand(value) {
    adopt(value, getPointer(1, this));
  }
  _disownBrand() {
    return disown(this.brand);
  }
  /**
  * Brand of the annotation.
  *
  * Note that the annotation itself is not allowed to be parameterized, but its scope might be.
  *
  */
  get brand() {
    return getStruct(1, Brand, this);
  }
  _hasBrand() {
    return !isNull(getPointer(1, this));
  }
  _initBrand() {
    return initStructAt(1, Brand, this);
  }
  set brand(value) {
    copyFrom(value, getPointer(1, this));
  }
  _adoptValue(value) {
    adopt(value, getPointer(0, this));
  }
  _disownValue() {
    return disown(this.value);
  }
  get value() {
    return getStruct(0, Value, this);
  }
  _hasValue() {
    return !isNull(getPointer(0, this));
  }
  _initValue() {
    return initStructAt(0, Value, this);
  }
  set value(value) {
    copyFrom(value, getPointer(0, this));
  }
  toString() {
    return "Annotation_" + super.toString();
  }
}
const ElementSize = {
  /**
  * aka "void", but that's a keyword.
  *
  */
  EMPTY: 0,
  BIT: 1,
  BYTE: 2,
  TWO_BYTES: 3,
  FOUR_BYTES: 4,
  EIGHT_BYTES: 5,
  POINTER: 6,
  INLINE_COMPOSITE: 7
};
class CapnpVersion extends Struct {
  static _capnp = {
    displayName: "CapnpVersion",
    id: "d85d305b7d839963",
    typeId: 0xd85d305b7d839963n,
    typeIdHex: "d85d305b7d839963",
    size: new ObjectSize(8, 0),
    fields: [
      { name: "major", codeOrder: 0, ordinal: 0, kind: "slot", offset: 0, type: { kind: "uint16" } },
      { name: "minor", codeOrder: 1, ordinal: 1, kind: "slot", offset: 2, type: { kind: "uint8" } },
      { name: "micro", codeOrder: 2, ordinal: 2, kind: "slot", offset: 3, type: { kind: "uint8" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["major"];
      if (value2 !== void 0) {
        target.major = value2;
      }
    }
    {
      const value2 = init["minor"];
      if (value2 !== void 0) {
        target.minor = value2;
      }
    }
    {
      const value2 = init["micro"];
      if (value2 !== void 0) {
        target.micro = value2;
      }
    }
  }
  get major() {
    return getUint16(0, this);
  }
  set major(value) {
    setUint16(0, value, this);
  }
  get minor() {
    return getUint8(2, this);
  }
  set minor(value) {
    setUint8(2, value, this);
  }
  get micro() {
    return getUint8(3, this);
  }
  set micro(value) {
    setUint8(3, value, this);
  }
  toString() {
    return "CapnpVersion_" + super.toString();
  }
}
class CodeGeneratorRequest_RequestedFile_Import extends Struct {
  static _capnp = {
    displayName: "Import",
    id: "ae504193122357e5",
    typeId: 0xae504193122357e5n,
    typeIdHex: "ae504193122357e5",
    size: new ObjectSize(8, 1),
    fields: [
      { name: "id", codeOrder: 0, ordinal: 0, kind: "slot", offset: 0, type: { kind: "uint64" } },
      { name: "name", codeOrder: 1, ordinal: 1, kind: "slot", offset: 0, type: { kind: "text" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["id"];
      if (value2 !== void 0) {
        target.id = value2;
      }
    }
    {
      const value2 = init["name"];
      if (value2 !== void 0) {
        target.name = value2;
      }
    }
  }
  /**
  * ID of the imported file.
  *
  */
  get id() {
    return getUint64(0, this);
  }
  set id(value) {
    setUint64(0, value, this);
  }
  /**
  * Name which *this* file used to refer to the foreign file.  This may be a relative name.
  * This information is provided because it might be useful for code generation, e.g. to
  * generate #include directives in C++.  We don't put this in Node.file because this
  * information is only meaningful at compile time anyway.
  *
  * (On Zooko's triangle, this is the import's petname according to the importing file.)
  *
  */
  get name() {
    return getText(0, this);
  }
  set name(value) {
    setText(0, value, this);
  }
  toString() {
    return "CodeGeneratorRequest_RequestedFile_Import_" + super.toString();
  }
}
class CodeGeneratorRequest_RequestedFile extends Struct {
  static Import = CodeGeneratorRequest_RequestedFile_Import;
  static _capnp = {
    displayName: "RequestedFile",
    id: "cfea0eb02e810062",
    typeId: 0xcfea0eb02e810062n,
    typeIdHex: "cfea0eb02e810062",
    size: new ObjectSize(8, 2),
    fields: [
      { name: "id", codeOrder: 0, ordinal: 0, kind: "slot", offset: 0, type: { kind: "uint64" } },
      { name: "filename", codeOrder: 1, ordinal: 1, kind: "slot", offset: 0, type: { kind: "text" } },
      { name: "imports", codeOrder: 2, ordinal: 2, kind: "slot", offset: 1, type: { kind: "list", elementType: { kind: "struct", typeId: 0xae504193122357e5n, typeIdHex: "ae504193122357e5", displayName: "Import" } } }
    ]
  };
  static _Imports;
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["id"];
      if (value2 !== void 0) {
        target.id = value2;
      }
    }
    {
      const value2 = init["filename"];
      if (value2 !== void 0) {
        target.filename = value2;
      }
    }
    {
      const value2 = init["imports"];
      if (value2 !== void 0) {
        if (value2 instanceof List) {
          target.imports = value2;
        } else {
          const values = Array.isArray(value2) ? value2 : Array.from(value2);
          const list = target._initImports(values.length);
          for (let index = 0; index < values.length; index++) {
            const item = values[index];
            if (item instanceof CodeGeneratorRequest_RequestedFile_Import) {
              list.set(index, item);
            } else {
              CodeGeneratorRequest_RequestedFile_Import._applyInit(list.get(index), item);
            }
          }
        }
      }
    }
  }
  /**
  * ID of the file.
  *
  */
  get id() {
    return getUint64(0, this);
  }
  set id(value) {
    setUint64(0, value, this);
  }
  /**
  * Name of the file as it appeared on the command-line (minus the src-prefix).  You may use
  * this to decide where to write the output.
  *
  */
  get filename() {
    return getText(0, this);
  }
  set filename(value) {
    setText(0, value, this);
  }
  _adoptImports(value) {
    adopt(value, getPointer(1, this));
  }
  _disownImports() {
    return disown(this.imports);
  }
  /**
  * List of all imported paths seen in this file.
  *
  */
  get imports() {
    return getList(1, CodeGeneratorRequest_RequestedFile._Imports, this);
  }
  _hasImports() {
    return !isNull(getPointer(1, this));
  }
  _initImports(length) {
    return initList(1, CodeGeneratorRequest_RequestedFile._Imports, length, this);
  }
  set imports(value) {
    copyFrom(value, getPointer(1, this));
  }
  toString() {
    return "CodeGeneratorRequest_RequestedFile_" + super.toString();
  }
}
class CodeGeneratorRequest extends Struct {
  static RequestedFile = CodeGeneratorRequest_RequestedFile;
  static _capnp = {
    displayName: "CodeGeneratorRequest",
    id: "bfc546f6210ad7ce",
    typeId: 0xbfc546f6210ad7cen,
    typeIdHex: "bfc546f6210ad7ce",
    size: new ObjectSize(0, 4),
    fields: [
      { name: "capnpVersion", codeOrder: 0, ordinal: 2, kind: "slot", offset: 2, type: { kind: "struct", typeId: 0xd85d305b7d839963n, typeIdHex: "d85d305b7d839963", displayName: "CapnpVersion" } },
      { name: "nodes", codeOrder: 1, ordinal: 0, kind: "slot", offset: 0, type: { kind: "list", elementType: { kind: "struct", typeId: 0xe682ab4cf923a417n, typeIdHex: "e682ab4cf923a417", displayName: "Node" } } },
      { name: "sourceInfo", codeOrder: 2, ordinal: 3, kind: "slot", offset: 3, type: { kind: "list", elementType: { kind: "struct", typeId: 0xf38e1de3041357aen, typeIdHex: "f38e1de3041357ae", displayName: "SourceInfo" } } },
      { name: "requestedFiles", codeOrder: 3, ordinal: 1, kind: "slot", offset: 1, type: { kind: "list", elementType: { kind: "struct", typeId: 0xcfea0eb02e810062n, typeIdHex: "cfea0eb02e810062", displayName: "RequestedFile" } } }
    ]
  };
  static _Nodes;
  static _SourceInfo;
  static _RequestedFiles;
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["capnpVersion"];
      if (value2 !== void 0) {
        if (value2 instanceof CapnpVersion) {
          target.capnpVersion = value2;
        } else {
          CapnpVersion._applyInit(target._initCapnpVersion(), value2);
        }
      }
    }
    {
      const value2 = init["nodes"];
      if (value2 !== void 0) {
        if (value2 instanceof List) {
          target.nodes = value2;
        } else {
          const values = Array.isArray(value2) ? value2 : Array.from(value2);
          const list = target._initNodes(values.length);
          for (let index = 0; index < values.length; index++) {
            const item = values[index];
            if (item instanceof Node) {
              list.set(index, item);
            } else {
              Node._applyInit(list.get(index), item);
            }
          }
        }
      }
    }
    {
      const value2 = init["sourceInfo"];
      if (value2 !== void 0) {
        if (value2 instanceof List) {
          target.sourceInfo = value2;
        } else {
          const values = Array.isArray(value2) ? value2 : Array.from(value2);
          const list = target._initSourceInfo(values.length);
          for (let index = 0; index < values.length; index++) {
            const item = values[index];
            if (item instanceof Node_SourceInfo) {
              list.set(index, item);
            } else {
              Node_SourceInfo._applyInit(list.get(index), item);
            }
          }
        }
      }
    }
    {
      const value2 = init["requestedFiles"];
      if (value2 !== void 0) {
        if (value2 instanceof List) {
          target.requestedFiles = value2;
        } else {
          const values = Array.isArray(value2) ? value2 : Array.from(value2);
          const list = target._initRequestedFiles(values.length);
          for (let index = 0; index < values.length; index++) {
            const item = values[index];
            if (item instanceof CodeGeneratorRequest_RequestedFile) {
              list.set(index, item);
            } else {
              CodeGeneratorRequest_RequestedFile._applyInit(list.get(index), item);
            }
          }
        }
      }
    }
  }
  _adoptCapnpVersion(value) {
    adopt(value, getPointer(2, this));
  }
  _disownCapnpVersion() {
    return disown(this.capnpVersion);
  }
  /**
  * Version of the `capnp` executable. Generally, code generators should ignore this, but the code
  * generators that ship with `capnp` itself will print a warning if this mismatches since that
  * probably indicates something is misconfigured.
  *
  * The first version of 'capnp' to set this was 0.6.0. So, if it's missing, the compiler version
  * is older than that.
  *
  */
  get capnpVersion() {
    return getStruct(2, CapnpVersion, this);
  }
  _hasCapnpVersion() {
    return !isNull(getPointer(2, this));
  }
  _initCapnpVersion() {
    return initStructAt(2, CapnpVersion, this);
  }
  set capnpVersion(value) {
    copyFrom(value, getPointer(2, this));
  }
  _adoptNodes(value) {
    adopt(value, getPointer(0, this));
  }
  _disownNodes() {
    return disown(this.nodes);
  }
  /**
  * All nodes parsed by the compiler, including for the files on the command line and their
  * imports.
  *
  */
  get nodes() {
    return getList(0, CodeGeneratorRequest._Nodes, this);
  }
  _hasNodes() {
    return !isNull(getPointer(0, this));
  }
  _initNodes(length) {
    return initList(0, CodeGeneratorRequest._Nodes, length, this);
  }
  set nodes(value) {
    copyFrom(value, getPointer(0, this));
  }
  _adoptSourceInfo(value) {
    adopt(value, getPointer(3, this));
  }
  _disownSourceInfo() {
    return disown(this.sourceInfo);
  }
  /**
  * Information about the original source code for each node, where available. This array may be
  * omitted or may be missing some nodes if no info is available for them.
  *
  */
  get sourceInfo() {
    return getList(3, CodeGeneratorRequest._SourceInfo, this);
  }
  _hasSourceInfo() {
    return !isNull(getPointer(3, this));
  }
  _initSourceInfo(length) {
    return initList(3, CodeGeneratorRequest._SourceInfo, length, this);
  }
  set sourceInfo(value) {
    copyFrom(value, getPointer(3, this));
  }
  _adoptRequestedFiles(value) {
    adopt(value, getPointer(1, this));
  }
  _disownRequestedFiles() {
    return disown(this.requestedFiles);
  }
  /**
  * Files which were listed on the command line.
  *
  */
  get requestedFiles() {
    return getList(1, CodeGeneratorRequest._RequestedFiles, this);
  }
  _hasRequestedFiles() {
    return !isNull(getPointer(1, this));
  }
  _initRequestedFiles(length) {
    return initList(1, CodeGeneratorRequest._RequestedFiles, length, this);
  }
  set requestedFiles(value) {
    copyFrom(value, getPointer(1, this));
  }
  toString() {
    return "CodeGeneratorRequest_" + super.toString();
  }
}
Node_SourceInfo._Members = CompositeList(Node_SourceInfo_Member);
Node_Struct._Fields = CompositeList(Field);
Node_Enum._Enumerants = CompositeList(Enumerant);
Node_Interface._Methods = CompositeList(Method);
Node_Interface._Superclasses = CompositeList(Superclass);
Node._Parameters = CompositeList(Node_Parameter);
Node._NestedNodes = CompositeList(Node_NestedNode);
Node._Annotations = CompositeList(Annotation);
Field._Annotations = CompositeList(Annotation);
Enumerant._Annotations = CompositeList(Annotation);
Method._ImplicitParameters = CompositeList(Node_Parameter);
Method._Annotations = CompositeList(Annotation);
Brand_Scope._Bind = CompositeList(Brand_Binding);
Brand._Scopes = CompositeList(Brand_Scope);
CodeGeneratorRequest_RequestedFile._Imports = CompositeList(CodeGeneratorRequest_RequestedFile_Import);
CodeGeneratorRequest._Nodes = CompositeList(Node);
CodeGeneratorRequest._SourceInfo = CompositeList(Node_SourceInfo);
CodeGeneratorRequest._RequestedFiles = CompositeList(CodeGeneratorRequest_RequestedFile);

export { Annotation, Brand, Brand_Binding, Brand_Binding_Which, Brand_Scope, Brand_Scope_Which, CapnpVersion, CodeGeneratorRequest, CodeGeneratorRequest_RequestedFile, CodeGeneratorRequest_RequestedFile_Import, ElementSize, Enumerant, Field, Field_Group, Field_Ordinal, Field_Ordinal_Which, Field_Slot, Field_Which, Method, Node, Node_Annotation, Node_Const, Node_Enum, Node_Interface, Node_NestedNode, Node_Parameter, Node_SourceInfo, Node_SourceInfo_Member, Node_Struct, Node_Which, Superclass, Type, Type_AnyPointer, Type_AnyPointer_ImplicitMethodParameter, Type_AnyPointer_Parameter, Type_AnyPointer_Unconstrained, Type_AnyPointer_Unconstrained_Which, Type_AnyPointer_Which, Type_Enum, Type_Interface, Type_List, Type_Struct, Type_Which, Value, Value_Which, _capnpFileId };
