import * as $ from "@mnutt/capnp-es";
export declare const _capnpFileId = 14104530756441332801n;
export declare const NativeCapnpBridgeRequest_Which: {
    readonly CALL: 0;
    readonly DROP: 1;
    readonly SAVE: 2;
    readonly RESTORE: 3;
};
export type NativeCapnpBridgeRequest_Which = (typeof NativeCapnpBridgeRequest_Which)[keyof typeof NativeCapnpBridgeRequest_Which];
/**
* Versioned isolate-to-supervisor native Cap'n Proto bridge envelope.
*
* This is intentionally separate from IsolateObjectCapability. App-object RPC
* is private/local helper plumbing, while this envelope is for generated
* schema bindings that encode real Cap'n Proto params/results.
*
*/
export declare class NativeCapnpBridgeRequest extends $.Struct {
    static readonly CALL: 0;
    static readonly DROP: 1;
    static readonly SAVE: 2;
    static readonly RESTORE: 3;
    static readonly _capnp: {
        displayName: string;
        id: string;
        typeId: bigint;
        typeIdHex: string;
        size: $.ObjectSize;
        fields: readonly [{
            readonly name: "protocolVersion";
            readonly codeOrder: 0;
            readonly ordinal: 0;
            readonly kind: "slot";
            readonly offset: 0;
            readonly type: {
                readonly kind: "uint32";
            };
        }, {
            readonly name: "call";
            readonly codeOrder: 1;
            readonly ordinal: 1;
            readonly discriminantValue: 0;
            readonly kind: "slot";
            readonly offset: 0;
            readonly type: {
                readonly kind: "struct";
                readonly typeId: 12597198862460973315n;
                readonly typeIdHex: "aed23d9f61f0f103";
                readonly displayName: "NativeCapnpBridgeCall";
            };
        }, {
            readonly name: "drop";
            readonly codeOrder: 2;
            readonly ordinal: 2;
            readonly discriminantValue: 1;
            readonly kind: "slot";
            readonly offset: 0;
            readonly type: {
                readonly kind: "struct";
                readonly typeId: 15179734060256684173n;
                readonly typeIdHex: "d2a93fb3be7f688d";
                readonly displayName: "NativeCapnpBridgeDrop";
            };
        }, {
            readonly name: "save";
            readonly codeOrder: 3;
            readonly ordinal: 3;
            readonly discriminantValue: 2;
            readonly kind: "slot";
            readonly offset: 0;
            readonly type: {
                readonly kind: "struct";
                readonly typeId: 10445737788539266125n;
                readonly typeIdHex: "90f6b72cbec1e44d";
                readonly displayName: "NativeCapnpBridgeSave";
            };
        }, {
            readonly name: "restore";
            readonly codeOrder: 4;
            readonly ordinal: 4;
            readonly discriminantValue: 3;
            readonly kind: "slot";
            readonly offset: 0;
            readonly type: {
                readonly kind: "struct";
                readonly typeId: 14077647114178906214n;
                readonly typeIdHex: "c35dd976b9efc866";
                readonly displayName: "NativeCapnpBridgeRestore";
            };
        }];
    };
    get protocolVersion(): number;
    set protocolVersion(value: number);
    _adoptCall(value: $.Orphan<NativeCapnpBridgeCall>): void;
    _disownCall(): $.Orphan<NativeCapnpBridgeCall>;
    get call(): NativeCapnpBridgeCall;
    _hasCall(): boolean;
    _initCall(): NativeCapnpBridgeCall;
    get _isCall(): boolean;
    set call(value: NativeCapnpBridgeCall);
    _adoptDrop(value: $.Orphan<NativeCapnpBridgeDrop>): void;
    _disownDrop(): $.Orphan<NativeCapnpBridgeDrop>;
    get drop(): NativeCapnpBridgeDrop;
    _hasDrop(): boolean;
    _initDrop(): NativeCapnpBridgeDrop;
    get _isDrop(): boolean;
    set drop(value: NativeCapnpBridgeDrop);
    _adoptSave(value: $.Orphan<NativeCapnpBridgeSave>): void;
    _disownSave(): $.Orphan<NativeCapnpBridgeSave>;
    get save(): NativeCapnpBridgeSave;
    _hasSave(): boolean;
    _initSave(): NativeCapnpBridgeSave;
    get _isSave(): boolean;
    set save(value: NativeCapnpBridgeSave);
    _adoptRestore(value: $.Orphan<NativeCapnpBridgeRestore>): void;
    _disownRestore(): $.Orphan<NativeCapnpBridgeRestore>;
    get restore(): NativeCapnpBridgeRestore;
    _hasRestore(): boolean;
    _initRestore(): NativeCapnpBridgeRestore;
    get _isRestore(): boolean;
    set restore(value: NativeCapnpBridgeRestore);
    toString(): string;
    which(): NativeCapnpBridgeRequest_Which;
}
export declare const NativeCapnpBridgeResponse_Which: {
    readonly RESULT: 0;
    readonly CAPABILITY: 1;
    readonly SAVED: 2;
    readonly ACKNOWLEDGED: 3;
    readonly EXCEPTION: 4;
};
export type NativeCapnpBridgeResponse_Which = (typeof NativeCapnpBridgeResponse_Which)[keyof typeof NativeCapnpBridgeResponse_Which];
export declare class NativeCapnpBridgeResponse extends $.Struct {
    static readonly RESULT: 0;
    static readonly CAPABILITY: 1;
    static readonly SAVED: 2;
    static readonly ACKNOWLEDGED: 3;
    static readonly EXCEPTION: 4;
    static readonly _capnp: {
        displayName: string;
        id: string;
        typeId: bigint;
        typeIdHex: string;
        size: $.ObjectSize;
        fields: readonly [{
            readonly name: "protocolVersion";
            readonly codeOrder: 0;
            readonly ordinal: 0;
            readonly kind: "slot";
            readonly offset: 0;
            readonly type: {
                readonly kind: "uint32";
            };
        }, {
            readonly name: "result";
            readonly codeOrder: 1;
            readonly ordinal: 1;
            readonly discriminantValue: 0;
            readonly kind: "slot";
            readonly offset: 0;
            readonly type: {
                readonly kind: "struct";
                readonly typeId: 9705361486063268302n;
                readonly typeIdHex: "86b05ed9b18ef1ce";
                readonly displayName: "NativeCapnpBridgeResult";
            };
        }, {
            readonly name: "capability";
            readonly codeOrder: 2;
            readonly ordinal: 2;
            readonly discriminantValue: 1;
            readonly kind: "slot";
            readonly offset: 0;
            readonly type: {
                readonly kind: "struct";
                readonly typeId: 17580951089395862855n;
                readonly typeIdHex: "f3fc15de30f50d47";
                readonly displayName: "NativeCapnpCapabilitySlot";
            };
        }, {
            readonly name: "saved";
            readonly codeOrder: 3;
            readonly ordinal: 3;
            readonly discriminantValue: 2;
            readonly kind: "slot";
            readonly offset: 0;
            readonly type: {
                readonly kind: "struct";
                readonly typeId: 16690542925459595794n;
                readonly typeIdHex: "e7a0b85c446da212";
                readonly displayName: "NativeCapnpBridgeSaved";
            };
        }, {
            readonly name: "acknowledged";
            readonly codeOrder: 4;
            readonly ordinal: 4;
            readonly discriminantValue: 3;
            readonly kind: "slot";
            readonly offset: 0;
            readonly type: {
                readonly kind: "void";
            };
        }, {
            readonly name: "exception";
            readonly codeOrder: 5;
            readonly ordinal: 5;
            readonly discriminantValue: 4;
            readonly kind: "slot";
            readonly offset: 0;
            readonly type: {
                readonly kind: "struct";
                readonly typeId: 12973057260331482907n;
                readonly typeIdHex: "b4098ed814dc3f1b";
                readonly displayName: "NativeCapnpBridgeException";
            };
        }];
    };
    get protocolVersion(): number;
    set protocolVersion(value: number);
    _adoptResult(value: $.Orphan<NativeCapnpBridgeResult>): void;
    _disownResult(): $.Orphan<NativeCapnpBridgeResult>;
    get result(): NativeCapnpBridgeResult;
    _hasResult(): boolean;
    _initResult(): NativeCapnpBridgeResult;
    get _isResult(): boolean;
    set result(value: NativeCapnpBridgeResult);
    _adoptCapability(value: $.Orphan<NativeCapnpCapabilitySlot>): void;
    _disownCapability(): $.Orphan<NativeCapnpCapabilitySlot>;
    get capability(): NativeCapnpCapabilitySlot;
    _hasCapability(): boolean;
    _initCapability(): NativeCapnpCapabilitySlot;
    get _isCapability(): boolean;
    set capability(value: NativeCapnpCapabilitySlot);
    _adoptSaved(value: $.Orphan<NativeCapnpBridgeSaved>): void;
    _disownSaved(): $.Orphan<NativeCapnpBridgeSaved>;
    get saved(): NativeCapnpBridgeSaved;
    _hasSaved(): boolean;
    _initSaved(): NativeCapnpBridgeSaved;
    get _isSaved(): boolean;
    set saved(value: NativeCapnpBridgeSaved);
    get _isAcknowledged(): boolean;
    set acknowledged(_: true);
    _adoptException(value: $.Orphan<NativeCapnpBridgeException>): void;
    _disownException(): $.Orphan<NativeCapnpBridgeException>;
    get exception(): NativeCapnpBridgeException;
    _hasException(): boolean;
    _initException(): NativeCapnpBridgeException;
    get _isException(): boolean;
    set exception(value: NativeCapnpBridgeException);
    toString(): string;
    which(): NativeCapnpBridgeResponse_Which;
}
export declare class NativeCapnpBridgeCall extends $.Struct {
    static readonly _capnp: {
        displayName: string;
        id: string;
        typeId: bigint;
        typeIdHex: string;
        size: $.ObjectSize;
        fields: readonly [{
            readonly name: "target";
            readonly codeOrder: 0;
            readonly ordinal: 0;
            readonly kind: "slot";
            readonly offset: 0;
            readonly type: {
                readonly kind: "struct";
                readonly typeId: 17580951089395862855n;
                readonly typeIdHex: "f3fc15de30f50d47";
                readonly displayName: "NativeCapnpCapabilitySlot";
            };
        }, {
            readonly name: "interfaceId";
            readonly codeOrder: 1;
            readonly ordinal: 1;
            readonly kind: "slot";
            readonly offset: 0;
            readonly type: {
                readonly kind: "uint64";
            };
        }, {
            readonly name: "methodOrdinal";
            readonly codeOrder: 2;
            readonly ordinal: 2;
            readonly kind: "slot";
            readonly offset: 4;
            readonly type: {
                readonly kind: "uint16";
            };
        }, {
            readonly name: "methodName";
            readonly codeOrder: 3;
            readonly ordinal: 3;
            readonly kind: "slot";
            readonly offset: 1;
            readonly type: {
                readonly kind: "text";
            };
        }, {
            readonly name: "params";
            readonly codeOrder: 4;
            readonly ordinal: 4;
            readonly kind: "slot";
            readonly offset: 2;
            readonly type: {
                readonly kind: "struct";
                readonly typeId: 12774119480851862312n;
                readonly typeIdHex: "b146c9fcd6929328";
                readonly displayName: "NativeCapnpPayload";
            };
        }];
    };
    _adoptTarget(value: $.Orphan<NativeCapnpCapabilitySlot>): void;
    _disownTarget(): $.Orphan<NativeCapnpCapabilitySlot>;
    get target(): NativeCapnpCapabilitySlot;
    _hasTarget(): boolean;
    _initTarget(): NativeCapnpCapabilitySlot;
    set target(value: NativeCapnpCapabilitySlot);
    get interfaceId(): bigint;
    set interfaceId(value: bigint);
    get methodOrdinal(): number;
    set methodOrdinal(value: number);
    get methodName(): string;
    set methodName(value: string);
    _adoptParams(value: $.Orphan<NativeCapnpPayload>): void;
    _disownParams(): $.Orphan<NativeCapnpPayload>;
    get params(): NativeCapnpPayload;
    _hasParams(): boolean;
    _initParams(): NativeCapnpPayload;
    set params(value: NativeCapnpPayload);
    toString(): string;
}
export declare const NativeCapnpBridgeResult_Which: {
    readonly VALUE: 0;
    readonly EXCEPTION: 1;
    readonly CANCELED: 2;
};
export type NativeCapnpBridgeResult_Which = (typeof NativeCapnpBridgeResult_Which)[keyof typeof NativeCapnpBridgeResult_Which];
export declare class NativeCapnpBridgeResult extends $.Struct {
    static readonly VALUE: 0;
    static readonly EXCEPTION: 1;
    static readonly CANCELED: 2;
    static readonly _capnp: {
        displayName: string;
        id: string;
        typeId: bigint;
        typeIdHex: string;
        size: $.ObjectSize;
        fields: readonly [{
            readonly name: "value";
            readonly codeOrder: 0;
            readonly ordinal: 0;
            readonly discriminantValue: 0;
            readonly kind: "slot";
            readonly offset: 0;
            readonly type: {
                readonly kind: "struct";
                readonly typeId: 12774119480851862312n;
                readonly typeIdHex: "b146c9fcd6929328";
                readonly displayName: "NativeCapnpPayload";
            };
        }, {
            readonly name: "exception";
            readonly codeOrder: 1;
            readonly ordinal: 1;
            readonly discriminantValue: 1;
            readonly kind: "slot";
            readonly offset: 0;
            readonly type: {
                readonly kind: "struct";
                readonly typeId: 12973057260331482907n;
                readonly typeIdHex: "b4098ed814dc3f1b";
                readonly displayName: "NativeCapnpBridgeException";
            };
        }, {
            readonly name: "canceled";
            readonly codeOrder: 2;
            readonly ordinal: 2;
            readonly discriminantValue: 2;
            readonly kind: "slot";
            readonly offset: 0;
            readonly type: {
                readonly kind: "void";
            };
        }];
    };
    _adoptValue(value: $.Orphan<NativeCapnpPayload>): void;
    _disownValue(): $.Orphan<NativeCapnpPayload>;
    get value(): NativeCapnpPayload;
    _hasValue(): boolean;
    _initValue(): NativeCapnpPayload;
    get _isValue(): boolean;
    set value(value: NativeCapnpPayload);
    _adoptException(value: $.Orphan<NativeCapnpBridgeException>): void;
    _disownException(): $.Orphan<NativeCapnpBridgeException>;
    get exception(): NativeCapnpBridgeException;
    _hasException(): boolean;
    _initException(): NativeCapnpBridgeException;
    get _isException(): boolean;
    set exception(value: NativeCapnpBridgeException);
    get _isCanceled(): boolean;
    set canceled(_: true);
    toString(): string;
    which(): NativeCapnpBridgeResult_Which;
}
export declare class NativeCapnpBridgeDrop extends $.Struct {
    static readonly _capnp: {
        displayName: string;
        id: string;
        typeId: bigint;
        typeIdHex: string;
        size: $.ObjectSize;
        fields: readonly [{
            readonly name: "target";
            readonly codeOrder: 0;
            readonly ordinal: 0;
            readonly kind: "slot";
            readonly offset: 0;
            readonly type: {
                readonly kind: "struct";
                readonly typeId: 17580951089395862855n;
                readonly typeIdHex: "f3fc15de30f50d47";
                readonly displayName: "NativeCapnpCapabilitySlot";
            };
        }];
    };
    _adoptTarget(value: $.Orphan<NativeCapnpCapabilitySlot>): void;
    _disownTarget(): $.Orphan<NativeCapnpCapabilitySlot>;
    get target(): NativeCapnpCapabilitySlot;
    _hasTarget(): boolean;
    _initTarget(): NativeCapnpCapabilitySlot;
    set target(value: NativeCapnpCapabilitySlot);
    toString(): string;
}
export declare class NativeCapnpBridgeSave extends $.Struct {
    static readonly _capnp: {
        displayName: string;
        id: string;
        typeId: bigint;
        typeIdHex: string;
        size: $.ObjectSize;
        fields: readonly [{
            readonly name: "target";
            readonly codeOrder: 0;
            readonly ordinal: 0;
            readonly kind: "slot";
            readonly offset: 0;
            readonly type: {
                readonly kind: "struct";
                readonly typeId: 17580951089395862855n;
                readonly typeIdHex: "f3fc15de30f50d47";
                readonly displayName: "NativeCapnpCapabilitySlot";
            };
        }];
    };
    _adoptTarget(value: $.Orphan<NativeCapnpCapabilitySlot>): void;
    _disownTarget(): $.Orphan<NativeCapnpCapabilitySlot>;
    get target(): NativeCapnpCapabilitySlot;
    _hasTarget(): boolean;
    _initTarget(): NativeCapnpCapabilitySlot;
    set target(value: NativeCapnpCapabilitySlot);
    toString(): string;
}
export declare class NativeCapnpBridgeRestore extends $.Struct {
    static readonly _capnp: {
        displayName: string;
        id: string;
        typeId: bigint;
        typeIdHex: string;
        size: $.ObjectSize;
        fields: readonly [{
            readonly name: "token";
            readonly codeOrder: 0;
            readonly ordinal: 0;
            readonly kind: "slot";
            readonly offset: 0;
            readonly type: {
                readonly kind: "text";
            };
        }, {
            readonly name: "expectedInterfaceId";
            readonly codeOrder: 1;
            readonly ordinal: 1;
            readonly kind: "slot";
            readonly offset: 0;
            readonly type: {
                readonly kind: "uint64";
            };
        }, {
            readonly name: "expectedInterfaceName";
            readonly codeOrder: 2;
            readonly ordinal: 2;
            readonly kind: "slot";
            readonly offset: 1;
            readonly type: {
                readonly kind: "text";
            };
        }];
    };
    get token(): string;
    set token(value: string);
    get expectedInterfaceId(): bigint;
    set expectedInterfaceId(value: bigint);
    get expectedInterfaceName(): string;
    set expectedInterfaceName(value: string);
    toString(): string;
}
export declare class NativeCapnpBridgeSaved extends $.Struct {
    static readonly _capnp: {
        displayName: string;
        id: string;
        typeId: bigint;
        typeIdHex: string;
        size: $.ObjectSize;
        fields: readonly [{
            readonly name: "token";
            readonly codeOrder: 0;
            readonly ordinal: 0;
            readonly kind: "slot";
            readonly offset: 0;
            readonly type: {
                readonly kind: "text";
            };
        }];
    };
    get token(): string;
    set token(value: string);
    toString(): string;
}
/**
* Encoded Cap'n Proto message bytes plus the ordered capability table used by
* that message. The supervisor, not isolate JS, owns the live native handles.
*
*/
export declare class NativeCapnpPayload extends $.Struct {
    static readonly _capnp: {
        displayName: string;
        id: string;
        typeId: bigint;
        typeIdHex: string;
        size: $.ObjectSize;
        fields: readonly [{
            readonly name: "message";
            readonly codeOrder: 0;
            readonly ordinal: 0;
            readonly kind: "slot";
            readonly offset: 0;
            readonly type: {
                readonly kind: "data";
            };
        }, {
            readonly name: "capabilities";
            readonly codeOrder: 1;
            readonly ordinal: 1;
            readonly kind: "slot";
            readonly offset: 1;
            readonly type: {
                readonly kind: "list";
                readonly elementType: {
                    readonly kind: "struct";
                    readonly typeId: 17580951089395862855n;
                    readonly typeIdHex: "f3fc15de30f50d47";
                    readonly displayName: "NativeCapnpCapabilitySlot";
                };
            };
        }];
    };
    static _Capabilities: $.ListCtor<NativeCapnpCapabilitySlot>;
    _adoptMessage(value: $.Orphan<$.Data>): void;
    _disownMessage(): $.Orphan<$.Data>;
    get message(): $.Data;
    _hasMessage(): boolean;
    _initMessage(length: number): $.Data;
    set message(value: $.Data);
    _adoptCapabilities(value: $.Orphan<$.List<NativeCapnpCapabilitySlot>>): void;
    _disownCapabilities(): $.Orphan<$.List<NativeCapnpCapabilitySlot>>;
    get capabilities(): $.List<NativeCapnpCapabilitySlot>;
    _hasCapabilities(): boolean;
    _initCapabilities(length: number): $.List<NativeCapnpCapabilitySlot>;
    set capabilities(value: $.List<NativeCapnpCapabilitySlot>);
    toString(): string;
}
export declare class NativeCapnpCapabilitySlot extends $.Struct {
    static readonly _capnp: {
        displayName: string;
        id: string;
        typeId: bigint;
        typeIdHex: string;
        size: $.ObjectSize;
        fields: readonly [{
            readonly name: "id";
            readonly codeOrder: 0;
            readonly ordinal: 0;
            readonly kind: "slot";
            readonly offset: 0;
            readonly type: {
                readonly kind: "text";
            };
        }, {
            readonly name: "interfaceId";
            readonly codeOrder: 1;
            readonly ordinal: 1;
            readonly kind: "slot";
            readonly offset: 0;
            readonly type: {
                readonly kind: "uint64";
            };
        }, {
            readonly name: "interfaceName";
            readonly codeOrder: 2;
            readonly ordinal: 2;
            readonly kind: "slot";
            readonly offset: 1;
            readonly type: {
                readonly kind: "text";
            };
        }, {
            readonly name: "kind";
            readonly codeOrder: 3;
            readonly ordinal: 3;
            readonly kind: "slot";
            readonly offset: 4;
            readonly type: {
                readonly kind: "enum";
                readonly typeId: 9745828926045402079n;
                readonly typeIdHex: "874023c5caa9b3df";
                readonly displayName: "NativeCapnpCapabilitySlotKind";
            };
        }];
    };
    get id(): string;
    set id(value: string);
    get interfaceId(): bigint;
    set interfaceId(value: bigint);
    get interfaceName(): string;
    set interfaceName(value: string);
    get kind(): NativeCapnpCapabilitySlotKind;
    set kind(value: NativeCapnpCapabilitySlotKind);
    toString(): string;
}
export declare const NativeCapnpCapabilitySlotKind: {
    readonly SENDER_HOSTED: 0;
    readonly RECEIVER_HOSTED: 1;
    readonly SAVED_TOKEN: 2;
};
export type NativeCapnpCapabilitySlotKind = (typeof NativeCapnpCapabilitySlotKind)[keyof typeof NativeCapnpCapabilitySlotKind];
export declare class NativeCapnpBridgeException extends $.Struct {
    static readonly _capnp: {
        displayName: string;
        id: string;
        typeId: bigint;
        typeIdHex: string;
        size: $.ObjectSize;
        fields: readonly [{
            readonly name: "type";
            readonly codeOrder: 0;
            readonly ordinal: 0;
            readonly kind: "slot";
            readonly offset: 0;
            readonly type: {
                readonly kind: "text";
            };
        }, {
            readonly name: "reason";
            readonly codeOrder: 1;
            readonly ordinal: 1;
            readonly kind: "slot";
            readonly offset: 1;
            readonly type: {
                readonly kind: "text";
            };
        }, {
            readonly name: "trace";
            readonly codeOrder: 2;
            readonly ordinal: 2;
            readonly kind: "slot";
            readonly offset: 2;
            readonly type: {
                readonly kind: "text";
            };
        }];
    };
    get type(): string;
    set type(value: string);
    get reason(): string;
    set reason(value: string);
    get trace(): string;
    set trace(value: string);
    toString(): string;
}
