declare module "sandstorm:capnp" {
  import type {
    Capability,
    RpcTarget,
    SaveCapabilityOptions,
  } from "sandstorm:api";

  export const SANDSTORM_CAPNP_VERSION: 0;
  export const SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION: 0;

  export type NativeCapnpBridgeFeature =
    "nativeTransport" | "nativeCalls" | "nativeExports" | "capabilitySlots";

  export interface NativeCapnpBridgeNegotiationOptions {
    requiredFeatures?: readonly NativeCapnpBridgeFeature[];
  }

  export interface NativeCapnpBridgeNegotiation {
    readonly available: boolean;
    readonly protocolSupported: boolean;
    readonly protocolVersion: 0;
    readonly nativeTransport: boolean;
    readonly nativeCalls: boolean;
    readonly nativeExports: boolean;
    readonly capabilitySlots: boolean;
    readonly fallbackTransport: string;
    readonly missingFeatures: readonly NativeCapnpBridgeFeature[];
    readonly reason: string;
    readonly info: unknown;
  }

  export function negotiateNativeCapnpBridgeInfo(
    info: unknown,
    options?: NativeCapnpBridgeNegotiationOptions,
  ): NativeCapnpBridgeNegotiation;

  export function negotiateNativeCapnpBridge(
    api: { capnpBridgeInfo(): Promise<unknown> },
    options?: NativeCapnpBridgeNegotiationOptions,
  ): Promise<NativeCapnpBridgeNegotiation>;

  export class NativeCapnpBridgeUnavailableError extends Error {
    readonly name: "NativeCapnpBridgeUnavailableError";
    readonly details: unknown;
    constructor(message: string, details?: unknown);
  }

  export class NativeCapnpBridgeProtocolError extends Error {
    readonly name: "NativeCapnpBridgeProtocolError";
    readonly details: unknown;
    constructor(message: string, details?: unknown);
  }

  export type NativeCapnpCapabilitySlotKind = "senderHosted" | "receiverHosted" | "savedToken";

  export interface NativeCapnpCapabilitySlot {
    readonly id: string;
    readonly interfaceId?: bigint | number | string;
    readonly interfaceName?: string;
    readonly kind?: NativeCapnpCapabilitySlotKind;
  }

  export interface NativeCapnpPayload {
    readonly message: Uint8Array;
    readonly capabilities: readonly Required<NativeCapnpCapabilitySlot>[];
  }

  export function makeNativeCapnpPayload(
    message?: { toUint8Array(): Uint8Array } | Uint8Array | ArrayBuffer | ArrayBufferView,
    capabilities?: readonly NativeCapnpCapabilitySlot[],
  ): NativeCapnpPayload;

  export interface NativeCapnpBridgeMethodMetadata {
    readonly interfaceId: bigint | number | string;
    readonly interfaceName?: string;
    readonly methodOrdinal: number;
    readonly methodName: string;
  }

  export interface NativeCapnpBridgeCallRequestOptions {
    readonly target: NativeCapnpCapabilitySlot;
    readonly method: NativeCapnpBridgeMethodMetadata;
    readonly payload?: NativeCapnpPayload;
  }

  export function makeNativeCapnpBridgeCallRequest(
    options?: NativeCapnpBridgeCallRequestOptions,
  ): NativeCapnpPayload;

  export interface NativeCapnpBridgeTargetRequestOptions {
    readonly target: NativeCapnpCapabilitySlot;
  }

  export function makeNativeCapnpBridgeDropRequest(
    options?: NativeCapnpBridgeTargetRequestOptions,
  ): NativeCapnpPayload;

  export function makeNativeCapnpBridgeSaveRequest(
    options?: NativeCapnpBridgeTargetRequestOptions,
  ): NativeCapnpPayload;

  export interface NativeCapnpBridgeRestoreRequestOptions {
    readonly token: string;
    readonly expectedInterfaceId?: bigint | number | string;
    readonly expectedInterfaceName?: string;
  }

  export function makeNativeCapnpBridgeRestoreRequest(
    options?: NativeCapnpBridgeRestoreRequestOptions,
  ): NativeCapnpPayload;

  export function readNativeCapnpBridgeRequest(
    message: Uint8Array | ArrayBuffer | ArrayBufferView,
  ): unknown;

  export interface NativeCapnpBridgeException {
    readonly type: string;
    readonly reason: string;
    readonly trace?: string;
  }

  export interface NativeCapnpBridgeResultResponseOptions {
    readonly payload?: NativeCapnpPayload;
  }

  export function makeNativeCapnpBridgeResultResponse(
    options?: NativeCapnpBridgeResultResponseOptions,
  ): NativeCapnpPayload;

  export function makeNativeCapnpBridgeExceptionResponse(
    exception?: NativeCapnpBridgeException,
  ): NativeCapnpPayload;

  export function makeNativeCapnpBridgeCapabilityResponse(
    options?: { readonly capability: NativeCapnpCapabilitySlot },
  ): NativeCapnpPayload;

  export function makeNativeCapnpBridgeSavedResponse(
    options?: { readonly token: string },
  ): NativeCapnpPayload;

  export function makeNativeCapnpBridgeAcknowledgedResponse(): NativeCapnpPayload;

  export function readNativeCapnpBridgeResponse(
    message: Uint8Array | ArrayBuffer | ArrayBufferView,
  ): unknown;

  export type DecodedNativeCapnpBridgeResponse =
    | {
        readonly protocolVersion: 0;
        readonly which: "result";
        readonly result:
          | { readonly which: "value"; readonly value: NativeCapnpPayload }
          | { readonly which: "exception"; readonly exception: Required<NativeCapnpBridgeException> }
          | { readonly which: "canceled" };
      }
    | {
        readonly protocolVersion: 0;
        readonly which: "capability";
        readonly capability: Required<NativeCapnpCapabilitySlot>;
      }
    | {
        readonly protocolVersion: 0;
        readonly which: "saved";
        readonly saved: { readonly token: string };
      }
    | {
        readonly protocolVersion: 0;
        readonly which: "acknowledged";
      }
    | {
        readonly protocolVersion: 0;
        readonly which: "exception";
        readonly exception: Required<NativeCapnpBridgeException>;
      };

  export function decodeNativeCapnpBridgeResponse(
    message: Uint8Array | ArrayBuffer | ArrayBufferView,
  ): DecodedNativeCapnpBridgeResponse;

  export interface NativeCapnpBridgeCallOptions {
    readonly target: Capability;
    readonly binding: CapnpInterfaceBinding<any, any>;
    readonly methodName: string;
    readonly params?: { toUint8Array(): Uint8Array } | Uint8Array | ArrayBuffer | ArrayBufferView;
    readonly capabilities?: readonly NativeCapnpCapabilitySlot[];
  }

  export interface NativeCapnpBridge {
    readonly negotiation: NativeCapnpBridgeNegotiation;
    readonly available: boolean;
    readonly protocolVersion: 0;
    makePayload(
      message?: { toUint8Array(): Uint8Array } | Uint8Array | ArrayBuffer | ArrayBufferView,
      capabilities?: readonly NativeCapnpCapabilitySlot[],
    ): NativeCapnpPayload;
    call(options: NativeCapnpBridgeCallOptions): Promise<NativeCapnpPayload>;
    drop(options: { readonly target: Capability }): Promise<void>;
    save(options: { readonly target: Capability }): Promise<string>;
    restore(options: {
      readonly token: string;
      readonly binding?: CapnpInterfaceBinding<any, any>;
    }): Promise<Required<NativeCapnpCapabilitySlot>>;
  }

  export function createNativeCapnpBridge(
    api: {
      capnpBridgeInfo(): Promise<unknown>;
      nativeCapnpBridgeCall?(body?: BodyInit): Promise<unknown>;
      nativeCapnpBridgeCallBytes?(body?: BodyInit): Promise<{
        ok: boolean;
        status: number;
        contentType: string;
        body: Uint8Array;
      }>;
    },
    options?: NativeCapnpBridgeNegotiationOptions,
  ): Promise<NativeCapnpBridge>;

  export type CapnpRpcMethod = (...args: any[]) => unknown;
  export type CapnpMethodMap<TMethods> = {
    [K in keyof TMethods]: TMethods[K] extends CapnpRpcMethod ? TMethods[K] : never;
  };

  export type CapnpRpcClient<
    TMethods extends object = Record<string, CapnpRpcMethod>,
    TResultOverrides extends object = object,
  > = {
    [K in keyof TMethods]: TMethods[K] extends (...args: infer Args) => infer Result
      ? (...args: Args) => Promise<K extends keyof TResultOverrides
          ? TResultOverrides[K]
          : Awaited<Result>>
      : never;
  };

  export type CapnpCapabilityClient<
    TMethods extends object = Record<string, CapnpRpcMethod>,
    TResultOverrides extends object = object,
  > =
    CapnpRpcClient<TMethods, TResultOverrides> & {
      readonly capability: Capability;
      drop(): Promise<unknown>;
      save(options?: SaveCapabilityOptions): Promise<string>;
    };

  export type CapnpResultCapabilityBinding =
    CapnpInterfaceBinding<any, any> | (() => CapnpInterfaceBinding<any, any>);
  export type CapnpArgumentCapabilityBinding = CapnpResultCapabilityBinding;

  export type CapnpNativeInterface =
    "unknown" | "webSession" | "apiSession" | "outboundHttpSession" | "appObject";

  export interface CapnpNativeCapabilitySlot {
    nativeInterface: CapnpNativeInterface;
    fetch?: boolean;
  }

  export type CapnpCapabilityPath = string | readonly (string | number)[];

  export type CapnpResultCapabilityFields =
    Record<string, CapnpResultCapabilityBinding | CapnpNativeCapabilitySlot> |
    readonly (readonly [string, CapnpResultCapabilityBinding | CapnpNativeCapabilitySlot])[];

  export type CapnpResultCapabilityPaths =
    Record<string, CapnpResultCapabilityBinding | CapnpNativeCapabilitySlot> |
    readonly (readonly [
      CapnpCapabilityPath,
      CapnpResultCapabilityBinding | CapnpNativeCapabilitySlot,
    ])[];

  export type CapnpArgumentCapabilitySlot =
    CapnpArgumentCapabilityBinding | CapnpNativeCapabilitySlot;

  export type CapnpArgumentCapabilityFields =
    readonly string[] | Record<string, CapnpArgumentCapabilitySlot>;

  export type CapnpArgumentCapabilityPaths =
    readonly CapnpCapabilityPath[] |
    Record<string, CapnpArgumentCapabilitySlot> |
    readonly (readonly [CapnpCapabilityPath, CapnpArgumentCapabilitySlot])[];

  export interface CapnpResultCapabilityStruct {
    fields?: CapnpResultCapabilityFields;
    paths?: CapnpResultCapabilityPaths;
  }

  export type CapnpResultCapabilities<TMethods extends object> =
    Partial<Record<keyof TMethods & string,
      CapnpResultCapabilityBinding | CapnpResultCapabilityStruct | CapnpNativeCapabilitySlot>>;

  export type CapnpArgumentCapabilities<TMethods extends object> =
    Partial<Record<keyof TMethods & string, {
      indexes?: readonly number[];
      indices?: readonly number[];
      fields?: CapnpArgumentCapabilityFields;
      paths?: CapnpArgumentCapabilityPaths;
    }>>;

  export interface CapnpSchemaMetadata<TMethods extends object> {
    readonly importSpecifier: string;
    readonly interfaceName: string;
    readonly interfaceId: string;
    readonly schemaPath: string;
    readonly schemaText: string;
    readonly methodNames: readonly (keyof TMethods & string)[];
    readonly methodIds: Partial<Record<keyof TMethods & string, number>>;
    readonly paramStructIds: Partial<Record<keyof TMethods & string, string>>;
    readonly resultStructIds: Partial<Record<keyof TMethods & string, string>>;
    readonly argumentCapabilities: CapnpArgumentCapabilities<TMethods>;
    readonly resultCapabilities: CapnpResultCapabilities<TMethods>;
  }

  export interface CapnpInterfaceBinding<
    TMethods extends object = Record<string, CapnpRpcMethod>,
    TResultOverrides extends object = object,
  > {
    readonly interfaceName: string;
    readonly interfaceId: string;
    readonly schemaPath: string;
    readonly schema: CapnpSchemaMetadata<TMethods>;
    readonly methodNames: readonly (keyof TMethods & string)[];
    implement(methods: CapnpMethodMap<TMethods>): RpcTarget;
    cast(capability: Capability): CapnpCapabilityClient<TMethods, TResultOverrides>;
    local(methods: CapnpMethodMap<TMethods>): CapnpRpcClient<TMethods, TResultOverrides>;
    powerboxDescriptor(options?: unknown): never;
  }

  export function makeCapnpInterfaceBinding<
    TMethods extends object = Record<string, CapnpRpcMethod>,
    TResultOverrides extends object = object,
  >(
    interfaceName: string,
    methodNames: readonly (keyof TMethods & string)[],
    schema?: {
      importSpecifier?: string;
      interfaceId?: string;
      schemaPath?: string;
      schemaText?: string;
      methodIds?: Partial<Record<keyof TMethods & string, number>>;
      paramStructIds?: Partial<Record<keyof TMethods & string, string>>;
      resultStructIds?: Partial<Record<keyof TMethods & string, string>>;
      argumentCapabilities?: CapnpArgumentCapabilities<TMethods>;
      resultCapabilities?: CapnpResultCapabilities<TMethods>;
    },
  ): CapnpInterfaceBinding<TMethods, TResultOverrides>;
}

declare module "capnp:*" {
  import type { CapnpInterfaceBinding } from "sandstorm:capnp";

  export type {
    CapnpArgumentCapabilities,
    CapnpArgumentCapabilityBinding,
    CapnpArgumentCapabilityFields,
    CapnpArgumentCapabilityPaths,
    CapnpArgumentCapabilitySlot,
    CapnpCapabilityPath,
    CapnpCapabilityClient,
    CapnpInterfaceBinding,
    CapnpMethodMap,
    CapnpSchemaMetadata,
    CapnpResultCapabilities,
    CapnpResultCapabilityBinding,
    CapnpResultCapabilityPaths,
    CapnpNativeCapabilitySlot,
    CapnpNativeInterface,
    CapnpResultCapabilityFields,
    CapnpResultCapabilityStruct,
    CapnpRpcClient,
    CapnpRpcMethod,
  } from "sandstorm:capnp";

  export interface CapnpSchemaModule {
    readonly importSpecifier: string;
    readonly schemaPath: string;
    readonly schemaText: string;
    readonly interfaceNames: readonly string[];
    readonly [interfaceName: string]: unknown;
  }

  export const importSpecifier: string;
  export const schemaPath: string;
  export const schemaText: string;
  export const interfaceNames: readonly string[];

  const schema: CapnpSchemaModule;
  export default schema;
}
