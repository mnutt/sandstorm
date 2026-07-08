declare module "sandstorm:capnp" {
  import type {
    Capability,
  } from "sandstorm:api";

  export const SANDSTORM_CAPNP_VERSION: 0;
  export const SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION: 0;

  export type NativeCapnpBridgeFeature =
    "nativeTransport" | "nativeRpc" | "nativeRpcWebSocket" |
    "nativeExports";

  export interface NativeCapnpBridgeNegotiationOptions {
    requiredFeatures?: readonly NativeCapnpBridgeFeature[];
  }

  export interface NativeCapnpBridgeNegotiation {
    readonly available: boolean;
    readonly protocolSupported: boolean;
    readonly protocolVersion: 0;
    readonly nativeTransport: boolean;
    readonly nativeRpc: boolean;
    readonly nativeRpcWebSocket: boolean;
    readonly nativeExports: boolean;
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

  export interface NativeCapnpBridge {
    readonly negotiation: NativeCapnpBridgeNegotiation;
    readonly available: boolean;
    readonly protocolVersion: 0;
    drop(options: { readonly target: Capability }): Promise<void>;
    save(options: { readonly target: Capability }): Promise<string>;
    restore(options: {
      readonly token: string;
      readonly binding?: NativeCapnpGeneratedInterface<any>;
    }): Promise<Required<NativeCapnpCapabilitySlot>>;
  }

  export function createNativeCapnpBridge(
    api: {
      capnpBridgeInfo(): Promise<unknown>;
      nativeCapnpBridgeLifecycle?(body?: BodyInit): Promise<unknown>;
      nativeCapnpBridgeLifecycleBytes?(body?: BodyInit): Promise<{
        ok: boolean;
        status: number;
        contentType: string;
        body: Uint8Array;
      }>;
      nativeCapnpBridgeOpenRpcSession?(
        target: NativeCapnpCapabilitySlot,
        connectionId: string,
      ): Promise<WebSocket>;
      nativeCapnpBridgeOpenBootstrapSession?(connectionId: string): Promise<WebSocket>;
    },
    options?: NativeCapnpBridgeNegotiationOptions,
  ): Promise<NativeCapnpBridge>;

  export class NativeCapnpBridgeWebSocketRpcTransport {
    readonly kind: "webSocketRpc";
    readonly api: {
      nativeCapnpBridgeOpenRpcSession(
        target: NativeCapnpCapabilitySlot,
        connectionId: string,
      ): Promise<WebSocket>;
    };
    readonly target: Required<NativeCapnpCapabilitySlot>;
    readonly connectionId: string;
    constructor(
      api: NativeCapnpBridgeWebSocketRpcTransport["api"],
      target: NativeCapnpCapabilitySlot,
      options?: {
        readonly connectionId?: string;
      },
    );
    sendMessage(message: unknown): void;
    recvMessage(): Promise<unknown>;
    close(error?: unknown): void;
  }

  export interface NativeCapnpLocalDirectTransport {
    readonly kind: "localDirect";
    readonly connectionId: string;
    readonly target: Required<NativeCapnpCapabilitySlot>;
    close(error?: unknown): void;
  }

  export class IsolateBridgeWebSocketRpcTransport {
    readonly kind: "isolateBridgeWebSocketRpc";
    readonly api: {
      nativeCapnpBridgeOpenBootstrapSession(connectionId: string): Promise<WebSocket>;
    };
    readonly connectionId: string;
    constructor(
      api: IsolateBridgeWebSocketRpcTransport["api"],
      options?: {
        readonly connectionId?: string;
      },
    );
    sendMessage(message: unknown): void;
    recvMessage(): Promise<unknown>;
    close(error?: unknown): void;
  }

  export function createIsolateBridgeConnection(
    api: {
      nativeCapnpBridgeOpenBootstrapSession?(connectionId: string): Promise<WebSocket>;
    },
    options?: {
      readonly connectionId?: string;
      readonly finalize?: unknown;
    },
  ): unknown;

  export type IsolateBridgeConnectedClient = {
    readonly connection: unknown;
    readonly transport: IsolateBridgeWebSocketRpcTransport;
    close(error?: unknown): void;
    getSandstormApi(params?: unknown): unknown;
    getSessionContext(params?: unknown): unknown;
  };

  export function connectIsolateBridge(
    api: {
      nativeCapnpBridgeOpenBootstrapSession?(connectionId: string): Promise<WebSocket>;
    },
    options?: {
      readonly connectionId?: string;
      readonly finalize?: unknown;
    },
  ): IsolateBridgeConnectedClient;

  export function nativeCapnpSavedTokenData(
    token: string | Uint8Array | ArrayBuffer | ArrayBufferView,
  ): Uint8Array;

  export function nativeCapnpSavedTokenText(
    token: string | Uint8Array | ArrayBuffer | ArrayBufferView,
  ): string;

  export class NativeCapnpStreamTransport {
    constructor(
      readable: ReadableStream<Uint8Array>,
      writable: WritableStream<Uint8Array>,
      options?: { readonly connection?: unknown },
    );
    attachConnection(connection: unknown): void;
    sendMessage(message: unknown): void;
    recvMessage(): Promise<unknown>;
    close(error?: unknown): void;
  }

  export function createNativeCapnpBridgeConnection(
    api: {
      nativeCapnpBridgeOpenRpcSession?(
        target: NativeCapnpCapabilitySlot,
        connectionId: string,
      ): Promise<WebSocket>;
    },
    target: NativeCapnpCapabilitySlot,
    options?: {
      readonly capabilities?: readonly NativeCapnpCapabilitySlot[];
      readonly connectionId?: string;
      readonly finalize?: unknown;
    },
  ): unknown;

  export function createNativeCapnpExportSession(
    InterfaceClass: NativeCapnpGeneratedInterface<object> & {
      readonly Server: new (target: object) => unknown;
    },
    target: object,
    options: {
      readonly readable: ReadableStream<Uint8Array>;
      readonly writable: WritableStream<Uint8Array>;
      readonly finalize?: unknown;
    },
  ): unknown;

  export interface NativeCapnpExportRegistration {
    readonly id: string;
    readonly InterfaceClass: NativeCapnpGeneratedInterface<object> & {
      readonly Server: new (target: object) => unknown;
    };
    readonly target: object;
    readonly interfaceMetadata: {
      readonly interfaceId: bigint | number | string;
      readonly interfaceName: string;
    };
    readonly path: string;
  }

  export function registerNativeCapnpExport(
    InterfaceClass: NativeCapnpGeneratedInterface<object> & {
      readonly Server: new (target: object) => unknown;
    },
    target: object,
    options?: {
      readonly id?: string;
      readonly interfaceId?: bigint | number | string;
      readonly interfaceName?: string;
      readonly schema?: {
        readonly interfaceId?: bigint | number | string;
        readonly interfaceName?: string;
      };
    },
  ): NativeCapnpExportRegistration;

  export function unregisterNativeCapnpExport(id: string): boolean;

  export function serveNativeCapnpExportSession(
    request: Request,
    options?: {
      readonly registry?: Map<string, NativeCapnpExportRegistration>;
      readonly finalize?: unknown;
    },
  ): Promise<Response | null>;

  export function exportNativeCapnp<TClient extends object>(
    api: {
      capnpBridgeInfo(): Promise<unknown>;
      nativeCapnpExport(registration: NativeCapnpExportRegistration): Promise<Capability>;
    },
    InterfaceClass: NativeCapnpGeneratedInterface<TClient> & {
      readonly Server: new (target: object) => unknown;
    },
    target: object,
    options?: {
      readonly interfaceId?: bigint | number | string;
      readonly interfaceName?: string;
      readonly schema?: {
        readonly interfaceId?: bigint | number | string;
        readonly interfaceName?: string;
      };
      readonly binding?: {
        readonly schema?: {
          readonly interfaceId?: bigint | number | string;
          readonly interfaceName?: string;
        };
      };
    },
  ): Promise<Capability>;

  export function saveNativeCapnp(
    api: {
      nativeCapnpBridgeLifecycleBytes(body?: BodyInit): Promise<{
        ok: boolean;
        status: number;
        contentType: string;
        body: Uint8Array;
      }>;
    },
    target: NativeCapnpCapabilitySlot,
  ): Promise<string>;

  export function dropNativeCapnp(
    api: {
      nativeCapnpBridgeLifecycleBytes(body?: BodyInit): Promise<{
        ok: boolean;
        status: number;
        contentType: string;
        body: Uint8Array;
      }>;
    },
    target: NativeCapnpCapabilitySlot,
  ): Promise<void>;

  export interface NativeCapnpGeneratedInterface<TClient extends object> {
    readonly Client: new (client: unknown) => TClient;
    readonly Server?: new (target: object) => { client(): TClient };
    readonly interfaceId?: bigint | number | string;
    readonly interfaceName?: string;
    readonly schema?: {
      readonly interfaceId?: bigint | number | string;
      readonly interfaceName?: string;
    };
    readonly _capnp?: {
      readonly displayName?: string;
      readonly typeId?: bigint;
      readonly typeIdHex?: string;
    };
  }

  export interface NativeCapnpPowerboxDescriptorInfo {
    readonly ok: true;
    readonly type: "packedPowerboxDescriptor";
    readonly descriptor: string;
    readonly decoded: {
      readonly interfaceId: string;
      readonly interfaceName: string;
    };
  }

  export function nativeCapnpPowerboxDescriptorInfo<TClient extends object>(
    env: { readonly SANDSTORM_API: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> } },
    InterfaceClass: NativeCapnpGeneratedInterface<TClient>,
    options?: {
      readonly interfaceId?: bigint | number | string;
      readonly interfaceName?: string;
      readonly schema?: {
        readonly interfaceId?: bigint | number | string;
        readonly interfaceName?: string;
      };
      readonly binding?: {
        readonly schema?: {
          readonly interfaceId?: bigint | number | string;
          readonly interfaceName?: string;
        };
      };
    },
  ): Promise<NativeCapnpPowerboxDescriptorInfo>;

  export function nativeCapnpPowerboxDescriptor<TClient extends object>(
    env: { readonly SANDSTORM_API: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> } },
    InterfaceClass: NativeCapnpGeneratedInterface<TClient>,
    options?: {
      readonly interfaceId?: bigint | number | string;
      readonly interfaceName?: string;
      readonly schema?: {
        readonly interfaceId?: bigint | number | string;
        readonly interfaceName?: string;
      };
      readonly binding?: {
        readonly schema?: {
          readonly interfaceId?: bigint | number | string;
          readonly interfaceName?: string;
        };
      };
    },
  ): Promise<string>;

  export interface NativeCapnpRpcImportCapability {
    readonly kind: "rpcImport";
    readonly interfaceId: bigint | number | string;
    readonly interfaceName: string;
  }

  export type NativeCapnpConnectedClient<TClient extends object> = TClient & {
    readonly capability: NativeCapnpCapabilitySlot | NativeCapnpRpcImportCapability;
    readonly connection: unknown;
    readonly transport:
      NativeCapnpBridgeWebSocketRpcTransport |
      NativeCapnpLocalDirectTransport |
      IsolateBridgeWebSocketRpcTransport;
    drop(): Promise<unknown> | unknown;
    save(...args: unknown[]): Promise<string> | string | undefined;
  };

  export function connectNativeCapnp<TClient extends object>(
    api: {
      nativeCapnpBridgeLifecycleBytes(body?: BodyInit): Promise<{
        ok: boolean;
        status: number;
        contentType: string;
        body: Uint8Array;
      }>;
      nativeCapnpBridgeOpenRpcSession?(
        target: NativeCapnpCapabilitySlot,
        connectionId: string,
      ): Promise<WebSocket>;
    },
    target: NativeCapnpCapabilitySlot,
    InterfaceClass: NativeCapnpGeneratedInterface<TClient>,
    options?: {
      readonly capabilities?: readonly NativeCapnpCapabilitySlot[];
      readonly connectionId?: string;
      readonly finalize?: unknown;
    },
  ): NativeCapnpConnectedClient<TClient>;

  export function restoreNativeCapnp<TClient extends object>(
    api: {
      capnpBridgeInfo(): Promise<unknown>;
      nativeCapnpBridgeOpenBootstrapSession?(connectionId: string): Promise<WebSocket>;
    },
    token: string | Uint8Array | ArrayBuffer | ArrayBufferView,
    InterfaceClass: NativeCapnpGeneratedInterface<TClient>,
    options?: {
      readonly capabilities?: readonly NativeCapnpCapabilitySlot[];
      readonly connectionId?: string;
      readonly finalize?: unknown;
      readonly interfaceId?: bigint | number | string;
      readonly interfaceName?: string;
      readonly schema?: {
        readonly interfaceId?: bigint | number | string;
        readonly interfaceName?: string;
      };
      readonly binding?: {
        readonly schema?: {
          readonly interfaceId?: bigint | number | string;
          readonly interfaceName?: string;
        };
      };
    },
  ): Promise<NativeCapnpConnectedClient<TClient>>;

  export function restoreNativeCapnpViaBootstrap<TClient extends object>(
    api: {
      capnpBridgeInfo(): Promise<unknown>;
      nativeCapnpBridgeOpenBootstrapSession?(connectionId: string): Promise<WebSocket>;
    },
    token: string | Uint8Array | ArrayBuffer | ArrayBufferView,
    InterfaceClass: NativeCapnpGeneratedInterface<TClient>,
    options?: {
      readonly connectionId?: string;
      readonly finalize?: unknown;
      readonly interfaceId?: bigint | number | string;
      readonly interfaceName?: string;
      readonly label?: string | object;
      readonly saveLabel?: string | object;
      readonly schema?: {
        readonly interfaceId?: bigint | number | string;
        readonly interfaceName?: string;
      };
      readonly binding?: {
        readonly schema?: {
          readonly interfaceId?: bigint | number | string;
          readonly interfaceName?: string;
        };
      };
    },
  ): Promise<NativeCapnpConnectedClient<TClient>>;

  export type CapnpNativeInterface =
    "unknown" | "webSession" | "apiSession" | "outboundHttpSession";

  export interface CapnpNativeCapabilitySlot {
    nativeInterface: CapnpNativeInterface;
    fetch?: boolean;
  }
}
