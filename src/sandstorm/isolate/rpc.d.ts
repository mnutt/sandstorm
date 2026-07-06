declare module "sandstorm:rpc" {
  export const SANDSTORM_RPC_VERSION: 0;
  export const SANDSTORM_CAPNWEB_VERSION: "0.8.0";

  export {
    RpcPromise,
    RpcSession,
    RpcSessionOptions,
    RpcStub,
    RpcTarget,
    deserialize,
    newHttpBatchRpcResponse,
    newHttpBatchRpcSession,
    newMessagePortRpcSession,
    newWebSocketRpcSession,
    newWorkersRpcResponse,
    newWorkersWebSocketRpcResponse,
    serialize,
  } from "capnweb";

  export function newSandstormRpcSession<Remote = unknown>(
    url?: string,
    options?: import("capnweb").RpcSessionOptions,
  ): import("capnweb").RpcStub<Remote>;
  export function requestPowerbox(
    query?: string[] | null,
    options?: {
      saveLabel?: { defaultText: string };
    },
  ): Promise<{ token: string; descriptor?: string }>;
  export function claimPowerboxToken(
    token: string,
    options?: {
      claimUrl?: string;
      requiredPermissions?: string[];
      apiSession?: unknown;
      apiSessionDescriptor?: unknown;
      outboundHttp?: unknown;
      outboundHttpDescriptor?: unknown;
      powerboxDescriptor?: string;
      descriptor?: string;
      nativeInterface?: string;
    },
  ): Promise<BrowserSandstormCapabilityHandle>;
  export function requestAndClaimPowerbox(
    query?: string[] | null,
    options?: {
      saveLabel?: { defaultText: string };
      claimUrl?: string;
      requiredPermissions?: string[];
      apiSession?: unknown;
      apiSessionDescriptor?: unknown;
      outboundHttp?: unknown;
      outboundHttpDescriptor?: unknown;
      powerboxDescriptor?: string;
      descriptor?: string;
      nativeInterface?: string;
    },
  ): Promise<{
    token: string;
    descriptor?: string;
    capability: BrowserSandstormCapabilityHandle;
  }>;
  export interface BrowserSandstormCapabilityHandle {
    readonly ok?: true;
    readonly type: "capability" | "claimedCapability";
    readonly id: string;
    readonly nativeInterface?: string;
  }
  export interface BrowserCapnpRequestCapabilityResult<TClient = unknown> {
    readonly token: string;
    readonly descriptor?: string;
    readonly capability: BrowserSandstormCapabilityHandle;
    readonly client: TClient & BrowserCapnpConnectedClient;
    readonly powerboxDescriptor: {
      readonly ok: true;
      readonly type: "packedPowerboxDescriptor";
      readonly descriptor: string;
      readonly decoded?: unknown;
    };
  }
  export interface BrowserCapnpInterfaceBinding<TClient = unknown> {
    readonly interfaceName: string;
    readonly interfaceId: string;
    readonly methodNames: readonly string[];
    readonly schema: {
      readonly interfaceName: string;
      readonly interfaceId?: string;
      readonly methodNames: readonly string[];
      readonly argumentCapabilities?: Record<string, unknown>;
      readonly resultCapabilities?: Record<string, unknown>;
    };
    cast(stub: unknown): TClient & BrowserCapnpConnectedClient;
    local(methods: Record<string, (...args: unknown[]) => unknown>): TClient;
    powerboxDescriptor(options?: Record<string, unknown>): Promise<string>;
    powerboxDescriptorInfo(options?: Record<string, unknown>): Promise<{
      readonly ok: true;
      readonly type: "packedPowerboxDescriptor";
      readonly descriptor: string;
      readonly decoded?: unknown;
    }>;
    requestCapability(
      options?: Record<string, unknown> & {
        readonly saveLabel?: { defaultText: string };
        readonly nativeInterface?: string;
      },
    ): Promise<BrowserCapnpRequestCapabilityResult<TClient>>;
  }
  export interface BrowserCapnpConnectedClient {
    readonly __sandstormCapnpBrowserStub: true;
    readonly stub: unknown;
    readonly capability?: BrowserSandstormCapabilityHandle;
    [Symbol.dispose]?(): void;
  }
  export function connectBrowserCapnp<TClient = unknown>(
    stub: unknown,
    binding: BrowserCapnpInterfaceBinding<TClient>,
  ): TClient & BrowserCapnpConnectedClient;
  export function makeBrowserCapnpInterfaceBinding<TClient = unknown>(
    interfaceName: string,
    methodNames: readonly string[],
    schema?: {
      readonly interfaceId?: string;
      readonly argumentCapabilities?: Record<string, unknown>;
      readonly resultCapabilities?: Record<string, unknown>;
    },
  ): BrowserCapnpInterfaceBinding<TClient>;
  export type OutboundHttpMethod =
    | "GET"
    | "POST"
    | "PUT"
    | "PATCH"
    | "DELETE"
    | "HEAD"
    | "OPTIONS";
  export function apiSessionPowerboxDescriptor(options: {
    canonicalUrl: string;
    oauthScopes?: string[];
    descriptorUrl?: string;
  }): Promise<string>;
  export function apiSessionPowerboxDescriptorInfo(options: {
    canonicalUrl: string;
    oauthScopes?: string[];
    descriptorUrl?: string;
  }): Promise<{
    ok: true;
    type: "packedPowerboxDescriptor";
    descriptor: string;
    decoded?: {
      type: "apiSession";
      canonicalUrl: string;
      oauthScopes: string[];
    };
  }>;
  export function outboundHttpPowerboxDescriptor(options: {
    baseUrl: string;
    methods?: OutboundHttpMethod[];
    descriptorUrl?: string;
  }): Promise<string>;
  export function outboundHttpPowerboxDescriptorInfo(options: {
    baseUrl: string;
    methods?: OutboundHttpMethod[];
    descriptorUrl?: string;
  }): Promise<{
    ok: true;
    type: "packedPowerboxDescriptor";
    descriptor: string;
    decoded?: {
      type: "outboundHttp";
      baseUrl: string;
      methods: OutboundHttpMethod[];
    };
  }>;
  export function providerTagPowerboxDescriptor(options: {
    descriptor: string;
  }): string;
  export const powerboxDescriptors: {
    apiSession: typeof apiSessionPowerboxDescriptor;
    apiSessionInfo: typeof apiSessionPowerboxDescriptorInfo;
    outboundHttp: typeof outboundHttpPowerboxDescriptor;
    outboundHttpInfo: typeof outboundHttpPowerboxDescriptorInfo;
    providerTag: typeof providerTagPowerboxDescriptor;
  };
  export function inspectPowerboxQuery(
    query:
      | string
      | string[]
      | { descriptor?: string; descriptors?: string[] }
      | {
        canonicalUrl: string;
        oauthScopes?: string[];
        descriptorUrl?: string;
      }
      | {
        apiSession?: {
          canonicalUrl: string;
          oauthScopes?: string[];
          descriptorUrl?: string;
        };
        apiSessionDescriptor?: {
          canonicalUrl: string;
          oauthScopes?: string[];
          descriptorUrl?: string;
        };
        outboundHttp?: {
          baseUrl: string;
          methods?: OutboundHttpMethod[];
          descriptorUrl?: string;
        };
        outboundHttpDescriptor?: {
          baseUrl: string;
          methods?: OutboundHttpMethod[];
          descriptorUrl?: string;
        };
      },
  ): Promise<{
    ok: true;
    type: "powerboxQueryInspection";
    descriptorCount: number;
    descriptors: Array<{
      index: number;
      type: string;
      descriptor: string;
      decoded?: {
        type: string;
        canonicalUrl?: string;
        oauthScopes?: string[];
        baseUrl?: string;
        methods?: OutboundHttpMethod[];
      };
    }>;
  }>;
  export function requestProviderPowerbox(options: {
    descriptor?: string;
    descriptors?: string[];
    saveLabel?: { defaultText: string };
  }): Promise<{
    token: string;
    descriptor?: string;
  }>;
  export function requestProviderCapability(options: {
    descriptor?: string;
    descriptors?: string[];
    saveLabel?: { defaultText: string };
    claimUrl?: string;
    requiredPermissions?: string[];
  }): Promise<{
    token: string;
    descriptor?: string;
    capability: {
      ok: true;
      type: "claimedCapability";
      id: string;
    };
  }>;
  export function requestApiPowerbox(options: {
    canonicalUrl: string;
    oauthScopes?: string[];
    saveLabel?: { defaultText: string };
    descriptorUrl?: string;
  }): Promise<{
    token: string;
    descriptor?: string;
    powerboxDescriptor: {
      ok: true;
      type: "packedPowerboxDescriptor";
      descriptor: string;
    };
  }>;
  export function requestApiCapability(options: {
    canonicalUrl: string;
    oauthScopes?: string[];
    saveLabel?: { defaultText: string };
    descriptorUrl?: string;
    claimUrl?: string;
    requiredPermissions?: string[];
  }): Promise<{
    token: string;
    descriptor?: string;
    powerboxDescriptor: {
      ok: true;
      type: "packedPowerboxDescriptor";
      descriptor: string;
    };
    capability: {
      ok: true;
      type: "claimedCapability";
      id: string;
    };
  }>;
  export function requestOutboundHttpPowerbox(options: {
    baseUrl: string;
    methods?: OutboundHttpMethod[];
    saveLabel?: { defaultText: string };
    descriptorUrl?: string;
  }): Promise<{
    token: string;
    descriptor?: string;
    powerboxDescriptor: {
      ok: true;
      type: "packedPowerboxDescriptor";
      descriptor: string;
    };
  }>;
  export function requestOutboundHttpCapability(options: {
    baseUrl: string;
    methods?: OutboundHttpMethod[];
    saveLabel?: { defaultText: string };
    descriptorUrl?: string;
    claimUrl?: string;
    requiredPermissions?: string[];
  }): Promise<{
    token: string;
    descriptor?: string;
    powerboxDescriptor: {
      ok: true;
      type: "packedPowerboxDescriptor";
      descriptor: string;
    };
    capability: {
      ok: true;
      type: "claimedCapability";
      id: string;
    };
  }>;
  export function browserClientScript(): string;
}
