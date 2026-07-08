declare module "sandstorm:api" {
  export const SANDSTORM_API_VERSION: 0;
  export const SANDSTORM_HELPER_VERSIONS: {
    readonly api: 0;
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

  export class ValidationError extends Error {}
  export class UnsupportedCapabilityError extends Error {
    readonly capability: string;
    readonly operation: string;
    constructor(capability: string, operation: string, message?: string);
  }
  export class CapabilityCallError extends Error {
    readonly details: unknown;
    constructor(message: string, details?: unknown);
  }
  export class DisconnectedCapabilityError extends Error {
    readonly details: unknown;
    constructor(message: string, details?: unknown);
  }

  export interface Validator {
    string(value: unknown, name?: string, options?: { minLength?: number; maxLength?: number }): string;
    number(value: unknown, name?: string, options?: { coerce?: boolean; min?: number; max?: number }): number;
    integer(value: unknown, name?: string, options?: { coerce?: boolean; min?: number; max?: number }): number;
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
    descriptor: string;
  }

  export interface OutboundHttpDescriptorInfo {
    type: "outboundHttp";
    baseUrl: string;
    methods: string[];
    descriptor: string;
  }

  export interface AppInterfaceDescriptorInfo {
    type: "appInterface";
    interfaceId: string;
    interfaceName?: string;
    descriptor: string;
  }

  export type PowerboxDescriptorInfo =
    | ApiSessionDescriptorInfo
    | OutboundHttpDescriptorInfo
    | AppInterfaceDescriptorInfo;

  export interface OfferedCapabilityInfo {
    id: string;
    capability?: Capability;
    descriptor?: PowerboxDescriptorInfo;
  }

  export interface StorageApi {
    put(key: string, value: string | Uint8Array | unknown): Promise<unknown>;
    putJson(key: string, value: unknown): Promise<unknown>;
    get(key: string): Promise<string | undefined>;
    getBytes(key: string): Promise<Uint8Array | undefined>;
    getJson<T = unknown>(key: string): Promise<T | undefined>;
    head(key: string): Promise<{ ok: boolean; status: number; bytes: string | null }>;
    delete(key: string): Promise<unknown>;
    list(): Promise<unknown>;
  }

  export interface WebSessionCapabilityOptions {
    pathPrefix?: string;
    prefix?: string;
    persistent?: boolean;
    dropNotifyPath?: string;
    title?: string | { defaultText: string };
    label?: string | { defaultText: string };
    description?: string | { defaultText: string };
  }

  export interface SaveCapabilityOptions {
    label?: string | { defaultText: string };
    saveLabel?: string | { defaultText: string };
  }

  export class Capability {
    readonly ok: true;
    readonly type: "capability";
    readonly id: string;
    readonly env: SandstormEnv;
    constructor(env: SandstormEnv, id: string);
    fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
    info(options?: { refresh?: boolean }): Promise<unknown>;
    save(options?: SaveCapabilityOptions): Promise<string>;
    dup(): Promise<Capability>;
    drop(): Promise<unknown>;
    offer(request: Request, options?: PowerboxOfferOptions): Promise<unknown>;
    fulfillRequest(request: Request, options?: PowerboxFulfillOptions): Promise<unknown>;
    tieToUser(request: Request, options?: PowerboxTieOptions): Promise<unknown>;
    toJSON(): { ok: true; type: "capability"; id: string };
  }

  export interface PowerboxRequestResult {
    token?: string;
    capability?: Capability | { id: string };
    descriptor?: unknown;
  }

  export interface PowerboxClaimOptions {
    requiredPermissions?: string[];
    apiSession?: unknown;
    apiSessionDescriptor?: unknown;
    outboundHttp?: unknown;
    outboundHttpDescriptor?: unknown;
    appInterface?: unknown;
    appInterfaceDescriptor?: unknown;
    descriptor?: string;
    powerboxDescriptor?: string;
    nativeInterface?: "unknown" | "webSession" | "apiSession" | "outboundHttpSession";
  }

  export interface PowerboxOfferOptions extends PowerboxClaimOptions {
    title?: string | { defaultText: string };
    label?: string | { defaultText: string };
    description?: string | { defaultText: string };
  }
  export interface PowerboxFulfillOptions extends PowerboxOfferOptions {}
  export interface PowerboxTieOptions {
    requiredPermissions?: string[];
  }

  export interface PowerboxApi {
    apiSessionDescriptor(options?: unknown): Promise<string>;
    outboundHttpDescriptor(options?: unknown): Promise<string>;
    appInterfaceDescriptor(options?: unknown): Promise<string>;
    claim(result: string | PowerboxRequestResult, options?: PowerboxClaimOptions): Promise<Capability>;
    offered(): OfferedCapabilityInfo | undefined;
    offer(capability: Capability, options?: PowerboxOfferOptions): Promise<unknown>;
    fulfillRequest(capability: Capability, options?: PowerboxFulfillOptions): Promise<unknown>;
    tieToUser(capability: Capability, options?: PowerboxTieOptions): Promise<unknown>;
  }

  export interface PowerboxFulfillmentOptions {
    routePrefix?: string;
    prefix?: string;
    title?: string;
    description?: string;
    buttonLabel?: string;
    capability(): Capability | { capability: Capability } | Promise<Capability | { capability: Capability }>;
    fulfill: PowerboxFulfillOptions;
  }

  export interface PowerboxFulfillmentApi {
    fulfill(request?: Request): Promise<unknown>;
    serve(request?: Request): Promise<Response | null>;
  }

  export interface PowerboxGrantSpec {
    id?: string;
    title?: string;
    label?: string;
    description?: string;
    storageKey?: string;
    key?: string;
    query?: unknown;
    descriptor?: string;
    descriptors?: string[];
    powerboxDescriptor?: string;
    apiSession?: unknown;
    apiSessionDescriptor?: unknown;
    outboundHttp?: unknown;
    outboundHttpDescriptor?: unknown;
    requiredPermissions?: string[];
    claimOptions?: PowerboxClaimOptions;
    save?: SaveCapabilityOptions;
    saveLabel?: string | { defaultText: string };
    test?: (capability: Capability) => unknown | Promise<unknown>;
  }

  export type PowerboxGrantsOptions =
    | Record<string, PowerboxGrantSpec>
    | { routePrefix?: string; prefix?: string; grants: Record<string, PowerboxGrantSpec> | PowerboxGrantSpec[] };

  export interface PowerboxGrantsApi {
    config(): Promise<unknown>;
    status(id?: string): Promise<unknown>;
    claim(id: string, result: string | PowerboxRequestResult): Promise<unknown>;
    revoke(id: string): Promise<unknown>;
    use<T>(id: string, fn: (capability: Capability) => T | Promise<T>): Promise<T>;
    token(id: string): Promise<string | undefined>;
    serve(request?: Request): Promise<Response | null>;
  }

  export interface CapnpBridgeInfo {
    ok: true;
    type: "capnpBridgeInfo";
    protocolVersion: 0;
    minProtocolVersion: 0;
    maxProtocolVersion: 0;
    nativeTransport: boolean;
    nativeRpc: boolean;
    nativeRpcWebSocket: boolean;
    nativeExports: boolean;
  }

  export interface NativeCapnpBridgeResponse {
    ok: boolean;
    type: "nativeCapnpBridgeResponse";
    protocolVersion: 0;
    error?: string;
    exception?: { type: string; reason: string; trace: string };
  }

  export interface NativeCapnpBridgeByteResponse {
    ok: boolean;
    status: number;
    contentType: string;
    body: Uint8Array;
  }

  export interface NativeCapnpExportRegistration {
    readonly id: string;
    readonly interfaceMetadata: {
      readonly interfaceId: bigint | number | string;
      readonly interfaceName: string;
    };
  }

  export interface SandstormApi {
    session(): SessionInfo;
    status(): Promise<unknown>;
    capabilities(): Promise<unknown>;
    runtime(): Promise<unknown>;
    modules(): Promise<unknown>;
    bindings(): Promise<unknown>;
    capnpBridgeInfo(): Promise<CapnpBridgeInfo>;
    nativeCapnpBridgeLifecycle(body?: BodyInit): Promise<NativeCapnpBridgeResponse>;
    nativeCapnpBridgeLifecycleBytes(body?: BodyInit): Promise<NativeCapnpBridgeByteResponse>;
    nativeCapnpBridgeOpenRpcSession(
      target: { id: string; interfaceId?: bigint | number | string; interfaceName?: string },
      connectionId: string,
    ): Promise<WebSocket>;
    nativeCapnpBridgeOpenBootstrapSession(connectionId: string): Promise<WebSocket>;
    nativeCapnpExport(registration: NativeCapnpExportRegistration): Promise<Capability>;
    storage(): StorageApi;
    powerbox(): PowerboxApi;
    webSession(options?: WebSessionCapabilityOptions): Promise<Capability>;
    apiSession(options?: WebSessionCapabilityOptions): Promise<Capability>;
    restore(token: string): Promise<Capability>;
    revoke(token: string): Promise<{ ok: true }>;
    use<T>(token: string, fn: (capability: Capability) => T | Promise<T>): Promise<T>;
    powerboxFulfillment(options: PowerboxFulfillmentOptions): PowerboxFulfillmentApi;
    powerboxGrants(options: PowerboxGrantsOptions): PowerboxGrantsApi;
    serveSystemRoutes(): Promise<Response | null>;
  }

  export function storage(env: SandstormEnv): StorageApi;
  export function powerbox(request: Request, env: SandstormEnv): PowerboxApi;
  export function powerboxGrants(
    request: Request,
    env: SandstormEnv,
    options: PowerboxGrantsOptions,
  ): PowerboxGrantsApi;
  export function powerboxFulfillment(
    request: Request,
    env: SandstormEnv,
    options: PowerboxFulfillmentOptions,
  ): PowerboxFulfillmentApi;
  export function getSession(request: Request): SessionInfo;
  export function servePowerboxDescriptors(
    request: Request,
    env: SandstormEnv,
  ): Promise<Response | null>;
  export function serveSystemRoutes(
    request: Request,
    env: SandstormEnv,
  ): Promise<Response | null>;
  export function nativeCapnpBrowserClientScript(): string;
  export function sandstorm(request: Request, env: SandstormEnv): SandstormApi;
}
