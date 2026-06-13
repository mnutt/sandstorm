declare module "sandstorm:api" {
  import type { RpcTarget, RpcSessionOptions } from "capnweb";

  export interface Fetcher {
    fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  }

  export interface SandstormEnv {
    SANDSTORM_API: Fetcher;
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
      tabId: string;
      basePath: string;
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

  export interface StorageApi {
    put(key: string, value: StorageValue): Promise<StorageInfo>;
    get(key: string): Promise<string | undefined>;
    getJson<T = unknown>(key: string): Promise<T | undefined>;
    head(key: string): Promise<{ ok: boolean; status: number; bytes: string | null }>;
    delete(key: string): Promise<StorageInfo>;
    list(): Promise<StorageListResult>;
  }

  export interface SandstormApiTarget extends RpcTarget {
    session(): SessionInfo;
    status(): Promise<unknown>;
    capabilities(): Promise<unknown>;
    runtime(): Promise<unknown>;
    modules(): Promise<unknown>;
    bindings(): Promise<unknown>;
    storage(): StorageApiTarget;
  }

  export interface StorageApiTarget extends RpcTarget, StorageApi {}

  export interface SandstormApi {
    session(): SessionInfo;
    status(): Promise<unknown>;
    capabilities(): Promise<unknown>;
    runtime(): Promise<unknown>;
    modules(): Promise<unknown>;
    bindings(): Promise<unknown>;
    storage(): StorageApi;
    apiTarget(): SandstormApiTarget;
    rpcClientScript(): string;
    rpcResponse(target: RpcTarget, options?: RpcSessionOptions): Response | Promise<Response>;
    serveRpc(
      target: RpcTargetSource,
      options?: ServeRpcOptions,
    ): Response | Promise<Response> | null;
  }

  export function storage(env: SandstormEnv): StorageApi;
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
