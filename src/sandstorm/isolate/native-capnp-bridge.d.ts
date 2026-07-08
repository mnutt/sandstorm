import * as $ from "capnp-es/index.mjs";
export declare const _capnpFileId = 14104530756441332801n;
export declare const NativeCapnpBridgeRequest_Which: {
    readonly DROP: 0;
    readonly SAVE: 1;
    readonly RESTORE: 2;
};
export type NativeCapnpBridgeRequest_Which = (typeof NativeCapnpBridgeRequest_Which)[keyof typeof NativeCapnpBridgeRequest_Which];
/**
* Versioned isolate-to-supervisor native Cap'n Proto bridge envelope.
*
* Generated schema RPC uses the WebSocket Cap'n Proto RPC session transport.
* This envelope is lifecycle-only: save, restore, and drop operations for
* already-held Sandstorm capability handles.
*
*/
export declare class NativeCapnpBridgeRequest extends $.Struct {
    static readonly DROP: 0;
    static readonly SAVE: 1;
    static readonly RESTORE: 2;
    static readonly _capnp: {
        displayName: string;
        id: string;
        typeId: bigint;
        typeIdHex: string;
        size: any;
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
            readonly name: "drop";
            readonly codeOrder: 1;
            readonly ordinal: 1;
            readonly discriminantValue: 0;
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
            readonly codeOrder: 2;
            readonly ordinal: 2;
            readonly discriminantValue: 1;
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
            readonly codeOrder: 3;
            readonly ordinal: 3;
            readonly discriminantValue: 2;
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
    static _applyInit(target: NativeCapnpBridgeRequest, value: $.Init<NativeCapnpBridgeRequest>): void;
    get protocolVersion(): number;
    set protocolVersion(value: number);
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
    _set(value: {
        which: "drop";
        value: NativeCapnpBridgeDrop;
    } | {
        which: "save";
        value: NativeCapnpBridgeSave;
    } | {
        which: "restore";
        value: NativeCapnpBridgeRestore;
    }): void;
    _match<R>(cases: {
        "drop"?: (value: NativeCapnpBridgeDrop) => R;
        "save"?: (value: NativeCapnpBridgeSave) => R;
        "restore"?: (value: NativeCapnpBridgeRestore) => R;
        _?: (which: NativeCapnpBridgeRequest_Which) => R;
    }): R;
}
export declare const NativeCapnpBridgeResponse_Which: {
    readonly CAPABILITY: 0;
    readonly SAVED: 1;
    readonly ACKNOWLEDGED: 2;
    readonly EXCEPTION: 3;
};
export type NativeCapnpBridgeResponse_Which = (typeof NativeCapnpBridgeResponse_Which)[keyof typeof NativeCapnpBridgeResponse_Which];
export declare class NativeCapnpBridgeResponse extends $.Struct {
    static readonly CAPABILITY: 0;
    static readonly SAVED: 1;
    static readonly ACKNOWLEDGED: 2;
    static readonly EXCEPTION: 3;
    static readonly _capnp: {
        displayName: string;
        id: string;
        typeId: bigint;
        typeIdHex: string;
        size: any;
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
            readonly name: "capability";
            readonly codeOrder: 1;
            readonly ordinal: 1;
            readonly discriminantValue: 0;
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
            readonly codeOrder: 2;
            readonly ordinal: 2;
            readonly discriminantValue: 1;
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
            readonly codeOrder: 3;
            readonly ordinal: 3;
            readonly discriminantValue: 2;
            readonly kind: "slot";
            readonly offset: 0;
            readonly type: {
                readonly kind: "void";
            };
        }, {
            readonly name: "exception";
            readonly codeOrder: 4;
            readonly ordinal: 4;
            readonly discriminantValue: 3;
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
    static _applyInit(target: NativeCapnpBridgeResponse, value: $.Init<NativeCapnpBridgeResponse>): void;
    get protocolVersion(): number;
    set protocolVersion(value: number);
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
    _set(value: {
        which: "capability";
        value: NativeCapnpCapabilitySlot;
    } | {
        which: "saved";
        value: NativeCapnpBridgeSaved;
    } | {
        which: "acknowledged";
    } | {
        which: "exception";
        value: NativeCapnpBridgeException;
    }): void;
    _match<R>(cases: {
        "capability"?: (value: NativeCapnpCapabilitySlot) => R;
        "saved"?: (value: NativeCapnpBridgeSaved) => R;
        "acknowledged"?: () => R;
        "exception"?: (value: NativeCapnpBridgeException) => R;
        _?: (which: NativeCapnpBridgeResponse_Which) => R;
    }): R;
}
export declare class NativeCapnpBridgeDrop extends $.Struct {
    static readonly _capnp: {
        displayName: string;
        id: string;
        typeId: bigint;
        typeIdHex: string;
        size: any;
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
    static _applyInit(target: NativeCapnpBridgeDrop, value: $.Init<NativeCapnpBridgeDrop>): void;
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
        size: any;
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
    static _applyInit(target: NativeCapnpBridgeSave, value: $.Init<NativeCapnpBridgeSave>): void;
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
        size: any;
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
    static _applyInit(target: NativeCapnpBridgeRestore, value: $.Init<NativeCapnpBridgeRestore>): void;
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
        size: any;
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
    static _applyInit(target: NativeCapnpBridgeSaved, value: $.Init<NativeCapnpBridgeSaved>): void;
    get token(): string;
    set token(value: string);
    toString(): string;
}
export declare class NativeCapnpCapabilitySlot extends $.Struct {
    static readonly _capnp: {
        displayName: string;
        id: string;
        typeId: bigint;
        typeIdHex: string;
        size: any;
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
        }, {
            readonly name: "localDispatch";
            readonly codeOrder: 4;
            readonly ordinal: 4;
            readonly kind: "slot";
            readonly offset: 2;
            readonly type: {
                readonly kind: "struct";
                readonly typeId: 11285229186937030789n;
                readonly typeIdHex: "9c9d302760408885";
                readonly displayName: "NativeCapnpLocalDispatch";
            };
        }];
    };
    static _applyInit(target: NativeCapnpCapabilitySlot, value: $.Init<NativeCapnpCapabilitySlot>): void;
    get id(): string;
    set id(value: string);
    get interfaceId(): bigint;
    set interfaceId(value: bigint);
    get interfaceName(): string;
    set interfaceName(value: string);
    get kind(): NativeCapnpCapabilitySlotKind;
    set kind(value: NativeCapnpCapabilitySlotKind);
    _adoptLocalDispatch(value: $.Orphan<NativeCapnpLocalDispatch>): void;
    _disownLocalDispatch(): $.Orphan<NativeCapnpLocalDispatch>;
    get localDispatch(): NativeCapnpLocalDispatch;
    _hasLocalDispatch(): boolean;
    _initLocalDispatch(): NativeCapnpLocalDispatch;
    set localDispatch(value: NativeCapnpLocalDispatch);
    toString(): string;
}
/**
* Opaque same-supervisor dispatch lease. The supervisor only includes this
* after restoring or otherwise validating an actual Sandstorm capability.
*
* Isolate runtimes must treat this as trusted metadata from the bridge, not
* app-provided authority. Raw export IDs are not sufficient to dispatch.
*
*/
export declare class NativeCapnpLocalDispatch extends $.Struct {
    static readonly _capnp: {
        displayName: string;
        id: string;
        typeId: bigint;
        typeIdHex: string;
        size: any;
        fields: readonly [{
            readonly name: "exportId";
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
            readonly name: "authorization";
            readonly codeOrder: 3;
            readonly ordinal: 3;
            readonly kind: "slot";
            readonly offset: 2;
            readonly type: {
                readonly kind: "text";
            };
        }];
    };
    static _applyInit(target: NativeCapnpLocalDispatch, value: $.Init<NativeCapnpLocalDispatch>): void;
    get exportId(): string;
    set exportId(value: string);
    get interfaceId(): bigint;
    set interfaceId(value: bigint);
    get interfaceName(): string;
    set interfaceName(value: string);
    get authorization(): string;
    set authorization(value: string);
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
        size: any;
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
    static _applyInit(target: NativeCapnpBridgeException, value: $.Init<NativeCapnpBridgeException>): void;
    get type(): string;
    set type(value: string);
    get reason(): string;
    set reason(value: string);
    get trace(): string;
    set trace(value: string);
    toString(): string;
}
