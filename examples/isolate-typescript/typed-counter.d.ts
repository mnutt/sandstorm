// Generated from typed-counter.capnp by the pinned capnp-es compiler.
import * as $ from "@mnutt/capnp-es";
export declare const _capnpFileId = 13825911482214888900n;
export declare class TypedCounter_Increment$Params extends $.Struct {
  static readonly _capnp: {
    displayName: string;
    id: string;
    typeId: bigint;
    typeIdHex: string;
    size: any;
    fields: readonly [{
      readonly name: "step";
      readonly codeOrder: 0;
      readonly ordinal: 0;
      readonly kind: "slot";
      readonly offset: 0;
      readonly type: { readonly kind: "int32" };
    }];
  };
  static _applyInit(
    target: TypedCounter_Increment$Params,
    value: $.Init<TypedCounter_Increment$Params>,
  ): void;
  get step(): number;
  set step(value: number);
  toString(): string;
}
export declare class TypedCounter_Increment$Results extends $.Struct {
  static readonly _capnp: {
    displayName: string;
    id: string;
    typeId: bigint;
    typeIdHex: string;
    size: any;
    fields: readonly [{
      readonly name: "value";
      readonly codeOrder: 0;
      readonly ordinal: 0;
      readonly kind: "slot";
      readonly offset: 0;
      readonly type: { readonly kind: "int32" };
    }];
  };
  static _applyInit(
    target: TypedCounter_Increment$Results,
    value: $.Init<TypedCounter_Increment$Results>,
  ): void;
  get value(): number;
  set value(value: number);
  toString(): string;
}
export declare class TypedCounter_Increment$Results$Promise {
  pipeline: $.Pipeline<
    TypedCounter_Increment$Results,
    $.Struct,
    TypedCounter_Increment$Results
  >;
  constructor(pipeline: $.Pipeline<
    TypedCounter_Increment$Results,
    $.Struct,
    TypedCounter_Increment$Results
  >);
  promise(): Promise<TypedCounter_Increment$Results>;
  then<TResult1 = TypedCounter_Increment$Results, TResult2 = never>(
    onfulfilled?: ((value: TypedCounter_Increment$Results) =>
      TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null,
  ): Promise<TypedCounter_Increment$Results | TResult>;
  finally(onfinally?: (() => void) | null): Promise<TypedCounter_Increment$Results>;
}
export declare class TypedCounter$Client {
  client: $.Client;
  static readonly interfaceId: bigint;
  constructor(client: $.Client);
  static readonly methods: [
    $.Method<TypedCounter_Increment$Params, TypedCounter_Increment$Results>,
  ];
  increment(): TypedCounter_Increment$Results$Promise;
  increment(params: $.Init<TypedCounter_Increment$Params>):
    TypedCounter_Increment$Results$Promise;
  increment(paramsFunc: (params: TypedCounter_Increment$Params) => void):
    TypedCounter_Increment$Results$Promise;
}
export interface TypedCounter$Server$Target {
  increment(
    params: TypedCounter_Increment$Params,
    results: TypedCounter_Increment$Results,
  ): $.MaybePromise<void | $.Init<TypedCounter_Increment$Results>>;
}
export declare class TypedCounter$Server extends $.Server {
  readonly target: TypedCounter$Server$Target;
  constructor(target: TypedCounter$Server$Target);
  client(): TypedCounter$Client;
}
export declare class TypedCounter extends $.Interface {
  static readonly Client: typeof TypedCounter$Client;
  static readonly Server: typeof TypedCounter$Server;
  static readonly _capnp: {
    displayName: string;
    id: string;
    typeId: bigint;
    typeIdHex: string;
    size: any;
    methods: [$.Method<TypedCounter_Increment$Params, TypedCounter_Increment$Results>];
  };
  toString(): string;
}
