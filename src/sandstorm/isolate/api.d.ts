declare module "sandstorm:api" {
  import type { RpcTarget, RpcSessionOptions } from "capnweb";
  export { RpcTarget } from "capnweb";

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
    | ClaimedCapabilityHandle
    | SavedCapability
    | CapabilityCallValue[]
    | { [key: string]: CapabilityCallValue };

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
    error?: string;
  }

  export interface ClaimedCapabilityHandle {
    ok: true;
    type: "claimedCapability";
    id: string;
  }

  export interface SaveCapabilityOptions {
    label?: string | { defaultText: string };
    saveLabel?: string | { defaultText: string };
  }

  export interface SessionCapabilityOptions {
    title?: string | { defaultText: string };
    displayTitle?: string | { defaultText: string };
    label?: string | { defaultText: string };
    requiredPermissions?: string[];
  }

  export interface WebSessionCapabilityOptions {
    pathPrefix?: string;
    prefix?: string;
    persistent?: boolean;
  }

  export interface SavedCapability {
    ok: true;
    type: "savedCapability";
    id: string;
    token: string;
    tokenEncoding: "base64url";
    restore(): Promise<ClaimedCapability>;
    drop(): Promise<{ ok: true }>;
  }

  export interface ClaimedCapability extends ClaimedCapabilityHandle {
    fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
    call<T = unknown>(method: string, ...args: CapabilityCallValue[]): Promise<T>;
    save(options?: SaveCapabilityOptions): Promise<SavedCapability>;
    drop(): Promise<{ ok: true }>;
    offer(request: Request, options?: SessionCapabilityOptions): Promise<{ ok: true }>;
    fulfillRequest(request: Request, options?: SessionCapabilityOptions): Promise<{ ok: true }>;
    tieToUser(request: Request, options?: SessionCapabilityOptions): Promise<ClaimedCapability>;
    [Symbol.dispose](): void;
  }

  export class ClaimedCapability {
    readonly ok: true;
    readonly type: "claimedCapability";
    readonly id: string;
    constructor(env: SandstormEnv, id: string);
    fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
    call<T = unknown>(method: string, ...args: CapabilityCallValue[]): Promise<T>;
    save(options?: SaveCapabilityOptions): Promise<SavedCapability>;
    drop(): Promise<{ ok: true }>;
    offer(request: Request, options?: SessionCapabilityOptions): Promise<{ ok: true }>;
    fulfillRequest(request: Request, options?: SessionCapabilityOptions): Promise<{ ok: true }>;
    tieToUser(request: Request, options?: SessionCapabilityOptions): Promise<ClaimedCapability>;
    [Symbol.dispose](): void;
    toJSON(): ClaimedCapabilityHandle;
  }

  export class SavedCapability {
    readonly ok: true;
    readonly type: "savedCapability";
    readonly id: string;
    readonly token: string;
    readonly tokenEncoding: "base64url";
    constructor(
      env: SandstormEnv,
      id: string,
      token: string | Uint8Array,
      tokenEncoding?: "base64url",
    );
    restore(): Promise<ClaimedCapability>;
    drop(): Promise<{ ok: true }>;
    toJSON(): {
      ok: true;
      type: "savedCapability";
      id: string;
      token: string;
      tokenEncoding: "base64url";
    };
  }

  export interface ClaimRequestOptions {
    requiredPermissions?: string[];
  }

  export interface StorageApi {
    put(key: string, value: StorageValue): Promise<StorageInfo>;
    get(key: string): Promise<string | undefined>;
    getJson<T = unknown>(key: string): Promise<T | undefined>;
    head(key: string): Promise<{ ok: boolean; status: number; bytes: string | null }>;
    delete(key: string): Promise<StorageInfo>;
    list(): Promise<StorageListResult>;
  }

  export interface PowerboxApi {
    request(query: unknown, options?: unknown): Promise<unknown>;
    claimRequest(token: string, options?: ClaimRequestOptions): Promise<ClaimedCapability>;
    offeredCapability(): ClaimedCapability | undefined;
    offer(
      capability: ClaimedCapabilityHandle | string,
      options?: SessionCapabilityOptions,
    ): Promise<{ ok: true }>;
    fulfillRequest(
      capability: ClaimedCapabilityHandle | string,
      options?: SessionCapabilityOptions,
    ): Promise<{ ok: true }>;
    tieToUser(
      capability: ClaimedCapabilityHandle | string,
      options?: SessionCapabilityOptions,
    ): Promise<ClaimedCapability>;
    save(
      capability: ClaimedCapabilityHandle | string,
      options?: SaveCapabilityOptions,
    ): Promise<SavedCapability>;
    restore(token: Uint8Array | string | SavedCapability): Promise<ClaimedCapability>;
    dropSaved(token: Uint8Array | string | SavedCapability): Promise<{ ok: true }>;
    drop(capability: ClaimedCapabilityHandle | string): Promise<{ ok: true }>;
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
    webSession(options?: WebSessionCapabilityOptions): Promise<ClaimedCapability>;
    capability(target: RpcTarget): Promise<ClaimedCapability>;
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
    webSession(options?: WebSessionCapabilityOptions): Promise<ClaimedCapability>;
    capability(target: RpcTarget): Promise<ClaimedCapability>;
    serveObjectCapabilities(): Promise<Response | null>;
    apiTarget(): SandstormApiTarget;
    rpcClientScript(): string;
    rpcResponse(target: RpcTarget, options?: RpcSessionOptions): Response | Promise<Response>;
    serveRpc(
      target: RpcTargetSource,
      options?: ServeRpcOptions,
    ): Response | Promise<Response> | null;
  }

  export function storage(env: SandstormEnv): StorageApi;
  export function powerbox(request: Request, env: SandstormEnv): PowerboxApi;
  export function getSession(request: Request): SessionInfo;
  export function apiTarget(request: Request, env: SandstormEnv): SandstormApiTarget;
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
  ): Response | Promise<Response> | null;
  export function sandstorm(request: Request, env: SandstormEnv): SandstormApi;
}
