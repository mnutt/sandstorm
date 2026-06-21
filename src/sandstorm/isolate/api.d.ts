declare module "sandstorm:api" {
  import type { RpcTarget, RpcSessionOptions } from "capnweb";
  export { RpcTarget } from "capnweb";
  export {
    SANDSTORM_CAPNWEB_VERSION,
    SANDSTORM_RPC_VERSION,
  } from "sandstorm:rpc";

  export const SANDSTORM_API_VERSION: 0;
  export const SANDSTORM_HELPER_VERSIONS: {
    readonly api: 0;
    readonly rpc: 0;
    readonly capnweb: "0.8.0";
  };

  export interface Fetcher {
    fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  }

  export interface SandstormEnv {
    SANDSTORM_API: Fetcher;
    POWERBOX?: Fetcher;
    STORAGE: Fetcher;
    [binding: string]: unknown;
  }

  export interface ServeRpcOptions extends RpcSessionOptions {
    rpcPath?: string;
    clientScriptPath?: string;
  }

  export type RpcTargetSource<T extends RpcTarget = RpcTarget> =
    | T
    | (() => T | Promise<T>);

  export class ValidationError extends Error {}
  export class UnsupportedCapabilityError extends Error {
    readonly capability: string;
    readonly operation: string;
    constructor(capability: string, operation: string);
  }
  export class CapabilityCallError extends Error {
    readonly details: unknown;
    constructor(message: string, details?: unknown);
  }
  export class DisconnectedCapabilityError extends Error {
    readonly details: unknown;
    constructor(message: string, details?: unknown);
  }

  export interface StringValidationOptions {
    minLength?: number;
    maxLength?: number;
  }

  export interface NumberValidationOptions {
    coerce?: boolean;
    min?: number;
    max?: number;
  }

  export interface Validator {
    string(value: unknown, name?: string, options?: StringValidationOptions): string;
    number(value: unknown, name?: string, options?: NumberValidationOptions): number;
    integer(value: unknown, name?: string, options?: NumberValidationOptions): number;
    optional<T>(
      value: unknown,
      fallback: T,
      validator: (value: unknown, name?: string, options?: unknown) => T,
      name?: string,
      options?: unknown,
    ): T;
    storageKey(value: unknown, name?: string): string;
  }

  export const validate: Validator;

  export interface SessionInfo {
    sessionType: string;
    user: {
      displayName: string;
      id: string;
      preferredHandle: string;
      pictureUrl: string;
      pronouns: string;
    };
    permissions: string[];
    request: {
      sessionId: string;
      tabId: string;
      basePath: string;
      offeredCapabilityId: string;
      host: string;
      forwardedProto: string;
      userAgent: string;
      acceptableLanguages: string[];
    };
    offer: OfferedCapabilityInfo;
  }

  export interface ApiSessionDescriptorInfo {
    type: "apiSession";
    canonicalUrl: string;
    oauthScopes: string[];
  }

  export type OutboundHttpMethod =
    | "GET"
    | "POST"
    | "PUT"
    | "PATCH"
    | "DELETE"
    | "HEAD"
    | "OPTIONS";

  export interface OutboundHttpDescriptorInfo {
    type: "outboundHttp";
    baseUrl: string;
    methods: OutboundHttpMethod[];
  }

  export type PowerboxDescriptorInfo = ApiSessionDescriptorInfo | OutboundHttpDescriptorInfo;

  export interface OfferedCapabilityInfo {
    id: string;
    capability?: Capability;
    descriptor?: PowerboxDescriptorInfo;
  }

  export type JsonValue =
    | null
    | boolean
    | number
    | string
    | JsonValue[]
    | { [key: string]: JsonValue };

  export type CapabilityCallValue =
    | JsonValue
    | RpcTarget
    | CapabilityHandle
    | CapabilityCallValue[]
    | { [key: string]: CapabilityCallValue };

  export interface NativeCapabilitySlot {
    type: "nativeCapabilitySlot";
    id: string;
    nativeInterface?: string;
  }

  export type NativeAppRpcPlainValue =
    | null
    | boolean
    | number
    | string
    | ArrayBuffer
    | ArrayBufferView
    | NativeCapabilitySlot
    | NativeAppRpcPlainValue[]
    | { [key: string]: NativeAppRpcPlainValue };

  export type NativeAppRpcSerializableValue =
    | NativeAppRpcPlainValue
    | RpcTarget
    | Capability;

  export type NativeAppRpcHydratedValue<TCapability = NativeCapabilitySlot> =
    | null
    | boolean
    | number
    | string
    | Uint8Array
    | TCapability
    | NativeAppRpcHydratedValue<TCapability>[]
    | { [key: string]: NativeAppRpcHydratedValue<TCapability> };

  export type NativeAppRpcValueEnvelope =
    | { type: "null" }
    | { type: "bool"; value: boolean }
    | { type: "number"; value: number }
    | { type: "text"; value: string }
    | { type: "data"; value: string }
    | { type: "list"; value: NativeAppRpcValueEnvelope[] }
    | { type: "object"; value: Array<{ name: string; value: NativeAppRpcValueEnvelope }> }
    | { type: "capability"; value: { id: string; nativeInterface?: string } };

  export interface NativeAppRpcCallEnvelope {
    method: string;
    args: NativeAppRpcValueEnvelope[];
  }

  export type NativeAppRpcResultEnvelope =
    | { type: "value"; value: NativeAppRpcValueEnvelope }
    | {
        type: "exception";
        value: {
          name: string;
          message: string;
          stack: string;
        };
      };

  export interface NativeAppRpcSerializationOptions {
    name?: string;
    exportRpcTargets?: boolean;
    exportCapabilitySlot?: (
      value: RpcTarget | Capability,
      context: { name: string },
    ) => NativeCapabilitySlot | Promise<NativeCapabilitySlot>;
  }

  export interface NativeAppRpcHydrationOptions<TCapability = NativeCapabilitySlot> {
    name?: string;
    resolveCapabilitySlot?: (
      slot: NativeCapabilitySlot,
      context: { name: string },
    ) => TCapability;
  }

  export interface NativeAppRpcStubOptions<TCapability = NativeCapabilitySlot>
      extends NativeAppRpcSerializationOptions, NativeAppRpcHydrationOptions<TCapability> {
    release?: (slot: NativeCapabilitySlot) => unknown | Promise<unknown>;
  }

  export interface CapabilityRpcOptions<TCapability = NativeCapabilitySlot>
      extends NativeAppRpcStubOptions<TCapability> {
    checkInfo?: boolean;
    transport?: NativeAppRpcTransport;
    fetcher?: Fetcher;
    route?: string | ((slot: NativeCapabilitySlot) => string);
  }

  export type NativeAppRpcTransport = (
    slot: NativeCapabilitySlot,
    call: NativeAppRpcCallEnvelope,
  ) => NativeAppRpcResultEnvelope | Promise<NativeAppRpcResultEnvelope>;

  export type StorageValue = string | Uint8Array | JsonValue;

  export interface StorageInfo {
    ok: boolean;
    status?: number;
    body?: string;
    bytes?: number;
    error?: string;
  }

  export interface StorageListResult {
    ok: boolean;
    keys: Array<{
      name: string;
      bytes: number;
    }>;
    totalBytes: number;
    error?: string;
  }

  export interface CapabilityHandle {
    ok: true;
    type: "capability";
    id: string;
  }

  export type CapabilityKind =
    | "unknown"
    | "powerboxClaim"
    | "powerboxOffer"
    | "restored"
    | "tied"
    | "routeBackedWebSession"
    | "routeBackedApiSession";

  export type CapabilityResidence =
    | "unknown"
    | "localExport"
    | "imported";

  export type CapabilityNativeInterface =
    | "unknown"
    | "webSession"
    | "apiSession"
    | "outboundHttpSession"
    | "appObject";

  export interface CapabilityInfo {
    ok: true;
    type: "capabilityInfo";
    id: string;
    kind: CapabilityKind;
    residence: CapabilityResidence;
    nativeInterface: CapabilityNativeInterface;
    pathPrefix: string;
    persistent: boolean;
    hasDropNotify: boolean;
    dropNotifyRefCount: number;
    supportsWebFetch: boolean;
    supportsOutboundHttpFetch: boolean;
    hasNativeCapability: boolean;
    liveForwardable: boolean;
  }

  export interface SaveCapabilityOptions {
    label?: string | { defaultText: string };
    saveLabel?: string | { defaultText: string };
  }

  export interface DurableObjectCapabilityOptions extends SaveCapabilityOptions {
    label: string | { defaultText: string };
    storageKey?: string;
    key?: string;
  }

  export interface DurableObjectCapabilityTargetOptions
      extends DurableObjectCapabilityOptions, Required<Pick<ObjectCapabilityOptions, "id">> {}

  export interface SessionCapabilityOptions {
    title?: string | { defaultText: string };
    displayTitle?: string | { defaultText: string };
    verbPhrase?: string | { defaultText: string };
    displayVerbPhrase?: string | { defaultText: string };
    description?: string | { defaultText: string };
    displayDescription?: string | { defaultText: string };
    label?: string | { defaultText: string };
    requiredPermissions?: string[];
    apiSession?: {
      canonicalUrl: string;
      oauthScopes?: string[];
    };
    apiSessionDescriptor?: {
      canonicalUrl: string;
      oauthScopes?: string[];
    };
    outboundHttp?: {
      baseUrl: string;
      methods?: OutboundHttpMethod[];
    };
    outboundHttpDescriptor?: {
      baseUrl: string;
      methods?: OutboundHttpMethod[];
    };
    descriptor?: string;
    powerboxDescriptor?: string;
  }

  export interface WebSessionCapabilityOptions {
    pathPrefix?: string;
    prefix?: string;
    persistent?: boolean;
  }

  export interface ObjectCapabilityOptions {
    id?: string;
    persistent?: boolean;
  }

  export type DurableCapabilityRegistry = Record<
    string,
    RpcTarget | ((request: Request, env: SandstormEnv) => RpcTarget)
  >;

  export interface SandstormOptions {
    capabilities?: DurableCapabilityRegistry;
  }

  export interface DurableObjectCapabilityResult {
    ok: true;
    id: string;
    storageKey: string;
    registered: boolean;
    restored: boolean;
    capability: Capability;
    token: string;
  }

  export type NativeAppRpcProxy<T extends object = Record<string, (...args: any[]) => unknown>> = {
    [K in keyof T]: T[K] extends (...args: infer Args) => infer Result
      ? (...args: Args) => Promise<Awaited<Result>>
      : never;
  };

  export interface Capability extends CapabilityHandle {
    fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
    call<T = unknown>(method: string, ...args: CapabilityCallValue[]): Promise<T>;
    readonly rpc: NativeAppRpcProxy<Record<string, (...args: any[]) => unknown>>;
    info(options?: { refresh?: boolean }): Promise<CapabilityInfo | null>;
    dup(): Promise<Capability>;
    save(options?: SaveCapabilityOptions): Promise<string>;
    drop(): Promise<{ ok: true }>;
    offer(request: Request, options?: SessionCapabilityOptions): Promise<{ ok: true }>;
    fulfillRequest(request: Request, options?: SessionCapabilityOptions): Promise<{ ok: true }>;
    tieToUser(request: Request, options?: SessionCapabilityOptions): Promise<Capability>;
    [Symbol.dispose](): void;
  }

  export class Capability {
    readonly ok: true;
    readonly type: "capability";
    readonly id: string;
    constructor(env: SandstormEnv, id: string);
    fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
    call<T = unknown>(method: string, ...args: CapabilityCallValue[]): Promise<T>;
    readonly rpc: NativeAppRpcProxy<Record<string, (...args: any[]) => unknown>>;
    info(options?: { refresh?: boolean }): Promise<CapabilityInfo | null>;
    dup(): Promise<Capability>;
    save(options?: SaveCapabilityOptions): Promise<string>;
    drop(): Promise<{ ok: true }>;
    offer(request: Request, options?: SessionCapabilityOptions): Promise<{ ok: true }>;
    fulfillRequest(request: Request, options?: SessionCapabilityOptions): Promise<{ ok: true }>;
    tieToUser(request: Request, options?: SessionCapabilityOptions): Promise<Capability>;
    [Symbol.dispose](): void;
    toJSON(): CapabilityHandle;
  }

  export class NativeAppRpcStub<
    T extends object = Record<string, (...args: any[]) => unknown>,
    TCapability = NativeCapabilitySlot,
  > {
    readonly slot: NativeCapabilitySlot;
    constructor(
      slot: Pick<NativeCapabilitySlot, "id"> & Partial<Pick<NativeCapabilitySlot, "nativeInterface">>,
      transport: NativeAppRpcTransport,
      options?: NativeAppRpcStubOptions<TCapability>,
    );
    call<TResult = unknown>(
      method: string,
      ...args: NativeAppRpcSerializableValue[]
    ): Promise<TResult>;
    drop(): Promise<unknown>;
    readonly rpc: NativeAppRpcProxy<T>;
    toJSON(): NativeCapabilitySlot;
  }

  export interface ClaimRequestOptions {
    requiredPermissions?: string[];
    apiSession?: {
      canonicalUrl: string;
      oauthScopes?: string[];
    };
    apiSessionDescriptor?: {
      canonicalUrl: string;
      oauthScopes?: string[];
    };
    outboundHttp?: {
      baseUrl: string;
      methods?: OutboundHttpMethod[];
    };
    outboundHttpDescriptor?: {
      baseUrl: string;
      methods?: OutboundHttpMethod[];
    };
    descriptor?: string;
    powerboxDescriptor?: string;
  }

  export type PowerboxRequestResult =
    | string
    | {
      token?: string;
      capability?: CapabilityHandle;
    };

  export interface ApiSessionPowerboxRequestOptions extends ClaimRequestOptions {
    canonicalUrl: string;
    oauthScopes?: string[];
  }

  export interface ApiSessionPowerboxRequestWrapperOptions extends ClaimRequestOptions {
    apiSession?: ApiSessionPowerboxRequestOptions;
    apiSessionDescriptor?: ApiSessionPowerboxRequestOptions;
  }

  export type ApiSessionPowerboxOptions =
    | ApiSessionPowerboxRequestOptions
    | ApiSessionPowerboxRequestWrapperOptions;

  export interface OutboundHttpPowerboxRequestOptions extends ClaimRequestOptions {
    baseUrl: string;
    methods?: OutboundHttpMethod[];
  }

  export interface OutboundHttpPowerboxRequestWrapperOptions extends ClaimRequestOptions {
    outboundHttp?: OutboundHttpPowerboxRequestOptions;
    outboundHttpDescriptor?: OutboundHttpPowerboxRequestOptions;
  }

  export type OutboundHttpPowerboxOptions =
    | OutboundHttpPowerboxRequestOptions
    | OutboundHttpPowerboxRequestWrapperOptions;

  export interface StorageApi {
    put(key: string, value: StorageValue): Promise<StorageInfo>;
    putJson(key: string, value: JsonValue): Promise<StorageInfo>;
    get(key: string): Promise<string | undefined>;
    getBytes(key: string): Promise<Uint8Array | undefined>;
    getJson<T = unknown>(key: string): Promise<T | undefined>;
    head(key: string): Promise<{ ok: boolean; status: number; bytes: string | null }>;
    delete(key: string): Promise<StorageInfo>;
    list(): Promise<StorageListResult>;
  }

  export interface PowerboxApi {
    apiSessionDescriptor(options: ApiSessionPowerboxOptions): Promise<string>;
    outboundHttpDescriptor(options: OutboundHttpPowerboxOptions): Promise<string>;
    claim(
      result: string | PowerboxRequestResult,
      options?: ClaimRequestOptions,
    ): Promise<Capability>;
    offered(): OfferedCapabilityInfo | undefined;
    offer(
      capability: CapabilityHandle | string,
      options?: SessionCapabilityOptions,
    ): Promise<{ ok: true }>;
    fulfillRequest(
      capability: CapabilityHandle | string,
      options?: SessionCapabilityOptions,
    ): Promise<{ ok: true }>;
    tieToUser(
      capability: CapabilityHandle | string,
      options?: SessionCapabilityOptions,
    ): Promise<Capability>;
  }

  export interface SandstormApiTarget extends RpcTarget {
    session(): SessionInfo;
    status(): Promise<unknown>;
    capabilities(): Promise<unknown>;
    runtime(): Promise<unknown>;
    modules(): Promise<unknown>;
    bindings(): Promise<unknown>;
    storage(): StorageApiTarget;
    powerbox(): PowerboxApiTarget;
    webSession(options?: WebSessionCapabilityOptions): Promise<Capability>;
    apiSession(options?: WebSessionCapabilityOptions): Promise<Capability>;
    restore(token: string): Promise<Capability>;
    revoke(token: string): Promise<{ ok: true }>;
    use<T>(
      token: string,
      fn: (capability: Capability) => T | Promise<T>,
    ): Promise<T>;
    "export"(target: RpcTarget, options?: ObjectCapabilityOptions): Promise<Capability>;
    withExport<T>(
      target: RpcTarget,
      fn: (capability: Capability) => T | Promise<T>,
      options?: ObjectCapabilityOptions,
    ): Promise<T>;
    exportDurable(
      target: RpcTarget,
      options: DurableObjectCapabilityTargetOptions,
    ): Promise<DurableObjectCapabilityResult>;
  }

  export interface StorageApiTarget extends RpcTarget, StorageApi {}
  export interface PowerboxApiTarget extends RpcTarget, PowerboxApi {}

  export interface SandstormApi {
    session(): SessionInfo;
    status(): Promise<unknown>;
    capabilities(): Promise<unknown>;
    runtime(): Promise<unknown>;
    modules(): Promise<unknown>;
    bindings(): Promise<unknown>;
    storage(): StorageApi;
    powerbox(): PowerboxApi;
    webSession(options?: WebSessionCapabilityOptions): Promise<Capability>;
    apiSession(options?: WebSessionCapabilityOptions): Promise<Capability>;
    restore(token: string): Promise<Capability>;
    revoke(token: string): Promise<{ ok: true }>;
    use<T>(
      token: string,
      fn: (capability: Capability) => T | Promise<T>,
    ): Promise<T>;
    export(target: RpcTarget, options?: ObjectCapabilityOptions): Promise<Capability>;
    withExport<T>(
      target: RpcTarget,
      fn: (capability: Capability) => T | Promise<T>,
      options?: ObjectCapabilityOptions,
    ): Promise<T>;
    exportDurable(target: RpcTarget, options: DurableObjectCapabilityTargetOptions):
      Promise<DurableObjectCapabilityResult>;
    exportDurable(id: string, options: DurableObjectCapabilityOptions):
      Promise<DurableObjectCapabilityResult>;
    serveObjectCapabilities(): Promise<Response | null>;
    servePowerboxDescriptors(): Promise<Response | null>;
    serveSystemRoutes(): Promise<Response | null>;
    apiTarget(): SandstormApiTarget;
    rpcClientScript(): string;
    rpcResponse(target: RpcTarget, options?: RpcSessionOptions): Response | Promise<Response>;
    serveRpc(
      target: RpcTargetSource,
      options?: ServeRpcOptions,
    ): Response | Promise<Response | null> | null;
  }

  export function storage(env: SandstormEnv): StorageApi;
  export function powerbox(request: Request, env: SandstormEnv): PowerboxApi;
  export function getSession(request: Request): SessionInfo;
  export function apiTarget(request: Request, env: SandstormEnv): SandstormApiTarget;
  export function servePowerboxDescriptors(
    request: Request,
    env: SandstormEnv,
  ): Promise<Response | null>;
  export function serveSystemRoutes(
    request: Request,
    env: SandstormEnv,
  ): Promise<Response | null>;
  export function rpcClientScript(): string;
  export function rpcResponse(
    request: Request,
    target: RpcTarget,
    options?: RpcSessionOptions,
  ): Response | Promise<Response>;
  export function serveRpc(
    request: Request,
    target: RpcTargetSource,
    options?: ServeRpcOptions,
  ): Response | Promise<Response | null> | null;
  export function nativeCapabilitySlot(
    id: string,
    options?: { nativeInterface?: string },
  ): NativeCapabilitySlot;
  export function serializeNativeAppRpcValue(
    value: NativeAppRpcPlainValue,
    options?: string | NativeAppRpcSerializationOptions,
  ): NativeAppRpcValueEnvelope;
  export function serializeNativeAppRpcValueAsync(
    value: NativeAppRpcSerializableValue,
    options?: string | NativeAppRpcSerializationOptions,
  ): Promise<NativeAppRpcValueEnvelope>;
  export function hydrateNativeAppRpcValue<TCapability = NativeCapabilitySlot>(
    value: NativeAppRpcValueEnvelope,
    options?: string | NativeAppRpcHydrationOptions<TCapability>,
  ): NativeAppRpcHydratedValue<TCapability>;
  export function serializeNativeAppRpcCall(
    method: string,
    args?: NativeAppRpcPlainValue[],
  ): NativeAppRpcCallEnvelope;
  export function serializeNativeAppRpcCallAsync(
    method: string,
    args?: NativeAppRpcSerializableValue[],
    options?: NativeAppRpcSerializationOptions,
  ): Promise<NativeAppRpcCallEnvelope>;
  export function hydrateNativeAppRpcCall(
    call: NativeAppRpcCallEnvelope,
    options?: string | NativeAppRpcHydrationOptions,
  ): { method: string; args: NativeAppRpcHydratedValue[] };
  export function hydrateNativeAppRpcCall<TCapability>(
    call: NativeAppRpcCallEnvelope,
    options: NativeAppRpcHydrationOptions<TCapability>,
  ): { method: string; args: NativeAppRpcHydratedValue<TCapability>[] };
  export function serializeNativeAppRpcResult(
    value: NativeAppRpcPlainValue,
  ): NativeAppRpcResultEnvelope;
  export function serializeNativeAppRpcResultAsync(
    value: NativeAppRpcSerializableValue,
    options?: NativeAppRpcSerializationOptions,
  ): Promise<NativeAppRpcResultEnvelope>;
  export function serializeNativeAppRpcException(error: unknown): NativeAppRpcResultEnvelope;
  export function hydrateNativeAppRpcResult<TCapability = NativeCapabilitySlot>(
    result: NativeAppRpcResultEnvelope,
    options?: string | NativeAppRpcHydrationOptions<TCapability>,
  ): NativeAppRpcHydratedValue<TCapability>;
  export function dispatchNativeAppRpcCall(
    target: object,
    call: NativeAppRpcCallEnvelope,
    options?: NativeAppRpcSerializationOptions & NativeAppRpcHydrationOptions,
  ): Promise<NativeAppRpcResultEnvelope>;
  export function createNativeAppRpcStub<
    T extends object = Record<string, (...args: any[]) => unknown>,
    TCapability = NativeCapabilitySlot,
  >(
    slot: Pick<NativeCapabilitySlot, "id"> & Partial<Pick<NativeCapabilitySlot, "nativeInterface">>,
    transport: NativeAppRpcTransport,
    options?: NativeAppRpcStubOptions<TCapability>,
  ): NativeAppRpcStub<T, TCapability>;
  export function createNativeAppRpcFetchTransport(
    fetcher: Fetcher,
    route: string | ((slot: NativeCapabilitySlot) => string),
  ): NativeAppRpcTransport;
  export function createClaimedCapabilityNativeAppRpcStub<
    T extends object = Record<string, (...args: any[]) => unknown>,
    TCapability = Capability,
  >(
    capability: Capability,
    options?: CapabilityRpcOptions<TCapability>,
  ): NativeAppRpcStub<T, TCapability>;
  export function sandstorm(
    request: Request,
    env: SandstormEnv,
    options?: SandstormOptions,
  ): SandstormApi;
}
