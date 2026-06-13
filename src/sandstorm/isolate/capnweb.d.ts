declare module "capnweb" {
  export interface RpcSessionOptions {
    [key: string]: unknown;
  }

  export interface RpcDisposable {
    [Symbol.dispose](): void;
  }

  export class RpcTarget {
    constructor();
  }

  export type RpcStub<T> = {
    [K in keyof T]: T[K] extends (...args: infer Args) => infer Result
      ? (...args: Args) => RpcPromise<Awaited<Result>>
      : RpcPromise<Awaited<T[K]>>;
  } & RpcDisposable & {
    dup(): RpcStub<T>;
    onRpcBroken(callback: (error: unknown) => void): void;
  };

  export type RpcPromise<T> = Promise<Awaited<T>> & RpcStub<Awaited<T>> & {
    map<U>(callback: (value: RpcPromise<Awaited<T>>) => U): RpcPromise<Awaited<U>>;
  };

  export class RpcSession<Remote = unknown> implements RpcDisposable {
    constructor(transport: unknown, localMain?: RpcTarget, options?: RpcSessionOptions);
    getRemoteMain(): RpcStub<Remote>;
    [Symbol.dispose](): void;
  }

  export function newHttpBatchRpcSession<Remote = unknown>(
    urlOrRequest: string | Request,
    options?: RpcSessionOptions,
  ): RpcStub<Remote>;

  export function newWebSocketRpcSession<Remote = unknown>(
    urlOrSocket: string | WebSocket,
    localMainOrOptions?: RpcTarget | RpcSessionOptions,
    options?: RpcSessionOptions,
  ): RpcStub<Remote> | RpcDisposable;

  export function newMessagePortRpcSession<Remote = unknown>(
    port: MessagePort,
    localMainOrOptions?: RpcTarget | RpcSessionOptions,
    options?: RpcSessionOptions,
  ): RpcStub<Remote>;

  export function newWorkersRpcResponse(
    request: Request,
    target: RpcTarget,
    options?: RpcSessionOptions,
  ): Response | Promise<Response>;

  export function newWorkersWebSocketRpcResponse(
    request: Request,
    target: RpcTarget,
    options?: RpcSessionOptions,
  ): Response | Promise<Response>;

  export function newHttpBatchRpcResponse(
    request: Request,
    target: RpcTarget,
    options?: RpcSessionOptions,
  ): Response | Promise<Response>;

  export function serialize(value: unknown): string;
  export function deserialize<T = unknown>(value: string): T;
}
