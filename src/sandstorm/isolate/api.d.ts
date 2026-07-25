declare module "sandstorm:api" {
  export const SANDSTORM_API_VERSION: 0;

  export interface SandstormEnv {
    [binding: string]: unknown;
  }

  export class ValidationError extends Error {}
  export class UnsupportedCapabilityError extends Error {
    readonly capability: string;
    readonly operation: string;
    constructor(capability: string, operation: string, message?: string);
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
      host: string;
      forwardedProto: string;
      userAgent: string;
      acceptableLanguages: string[];
    };
    offer: SessionOfferInfo;
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

  export interface SessionOfferInfo {
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

  export interface SaveCapabilityOptions {
    label?: string | { defaultText: string };
  }

  export class Capability {
    private readonly __sandstormCapabilityBrand: void;
    private constructor();
    readonly ok: true;
    readonly type: "capability";
    readonly id: string;
    readonly env: SandstormEnv;
    fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
    info(options?: { refresh?: boolean }): Promise<unknown>;
    save(options?: SaveCapabilityOptions): Promise<string>;
    drop(): Promise<void>;
    offer(request: Request, options?: PowerboxOfferOptions): Promise<unknown>;
    fulfillRequest(request: Request, options?: PowerboxFulfillOptions): Promise<unknown>;
    tieToUser(request: Request, options?: PowerboxTieOptions): Promise<unknown>;
    browserHandoff(options?: {
      nativeInterface?: string;
      request?: Request;
      sessionId?: string;
    }): Promise<{
      ok: true;
      type: "capability";
      id: string;
      kind: "receiverHosted";
      residence: "browserHandoff";
      nativeInterface: string;
    }>;
    toJSON(): { ok: true; type: "capability"; id: string };
  }

  export interface PowerboxRequestResult {
    token?: string;
    capability?: Capability;
    descriptor?: unknown;
  }

  export type LiveCapability =
    | Capability
    | CapnpExport<object>
    | WorkerCapnpExport<CapnpServerInterface>;

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
    appInterfaceDescriptor<I extends CapnpClientInterface>(InterfaceClass: I): Promise<string>;
    claim(result: string | PowerboxRequestResult, options?: PowerboxClaimOptions): Promise<Capability>;
    offered(): Promise<OfferedCapabilityInfo | undefined>;
    offer(capability: LiveCapability, options?: PowerboxOfferOptions): Promise<unknown>;
    fulfillRequest(capability: LiveCapability, options?: PowerboxFulfillOptions): Promise<unknown>;
    tieToUser(capability: LiveCapability, options?: PowerboxTieOptions): Promise<unknown>;
  }

  export interface PowerboxFulfillmentOptions {
    routePrefix?: string;
    title?: string;
    description?: string;
    buttonLabel?: string;
    capability(): LiveCapability | { capability: LiveCapability } |
        Promise<LiveCapability | { capability: LiveCapability }>;
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
    test?: (capability: Capability) => unknown | Promise<unknown>;
  }

  export type PowerboxGrantsOptions =
    | Record<string, PowerboxGrantSpec>
    | { routePrefix?: string; grants: Record<string, PowerboxGrantSpec> | PowerboxGrantSpec[] };

  export interface PowerboxGrantsApi {
    config(): Promise<unknown>;
    status(id?: string): Promise<unknown>;
    claim(id: string, result: string | PowerboxRequestResult): Promise<unknown>;
    revoke(id: string): Promise<unknown>;
    use<T>(id: string, fn: (capability: Capability) => T | Promise<T>): Promise<T>;
    token(id: string): Promise<string | undefined>;
    serve(request?: Request): Promise<Response | null>;
  }

  /**
   * Operational diagnostics with no compatibility guarantee for member names
   * or response shapes. The namespace itself is stable so experimental tools
   * do not need to add methods to SandstormApi's stable surface.
   */
  export interface UnstableSandstormDiagnostics {
    status(): Promise<unknown>;
  }

  export interface SandstormApi {
    session(): SessionInfo;
    readonly unstable: UnstableSandstormDiagnostics;
    storage(): StorageApi;
    powerbox(): PowerboxApi;
    capability(declaration: WorkerCapnpExport<CapnpServerInterface>): Promise<Capability>;
    restore(token: string): Promise<Capability>;
    revoke(token: string): Promise<{ ok: true }>;
    use<T>(token: string, fn: (capability: Capability) => T | Promise<T>): Promise<T>;
    powerboxFulfillment(options: PowerboxFulfillmentOptions): PowerboxFulfillmentApi;
    powerboxGrants(options: PowerboxGrantsOptions): PowerboxGrantsApi;
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
  export function sandstorm(request: Request, env: SandstormEnv): SandstormApi;
}
