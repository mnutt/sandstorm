// Split physically to keep the native helper declarations manageable, but
// augment the single public application module.
declare module "sandstorm:api" {
  export interface CapnpInterfaceMetadata {
    readonly typeId: bigint;
    readonly typeIdHex: string;
    readonly displayName: string;
  }

  export interface CapnpClientInterface {
    readonly Client: abstract new (...args: any[]) => object;
    readonly _capnp: CapnpInterfaceMetadata;
  }

  export interface CapnpServerInterface extends CapnpClientInterface {
    readonly Server: abstract new (...args: any[]) => { client(): object };
  }

  export interface CapnpStructClass {
    readonly _applyInit: (builder: any, value: any) => void;
    new (...args: any[]): object;
  }

  export type ClientFor<I extends CapnpClientInterface> = InstanceType<I["Client"]>;
  export type ServerTargetFor<I extends CapnpServerInterface> =
    ConstructorParameters<I["Server"]>[0];
  export type StructInitFor<S extends CapnpStructClass> = Parameters<S["_applyInit"]>[1];

  /** The workerd lifetime controls associated with one inbound worker event. */
  export interface WorkerExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
  }

  /** Environment and event lifetime for one inbound Cap'n Proto method call. */
  export interface WorkerCapnpCallContext<E extends SandstormEnv = SandstormEnv> {
    readonly env: E;
    readonly ctx: WorkerExecutionContext;
    /** Aborted when the Cap'n Proto caller cancels this method. */
    readonly signal: AbortSignal;
  }

  /**
   * A generated server target adapted for a worker export. Its second argument is
   * call context; the generated result builder moves to the third argument.
   */
  export type WorkerCapnpServerTargetFor<
    I extends CapnpServerInterface,
    E extends SandstormEnv = SandstormEnv,
  > = {
    [K in keyof ServerTargetFor<I>]: ServerTargetFor<I>[K] extends
      (params: infer P, results: infer R) => infer V
        ? (params: P, context: WorkerCapnpCallContext<E>, results: R) => V
        : ServerTargetFor<I>[K];
  };

  const workerCapnpExportBrand: unique symbol;

  /** An opaque declaration accepted by defineWorker(). */
  export interface WorkerCapnpExport<
    I extends CapnpServerInterface = CapnpServerInterface,
    E extends SandstormEnv = SandstormEnv,
  > {
    readonly [workerCapnpExportBrand]: { readonly interface: I; readonly env: E };
  }

  /** Recreates and cleans up application object IDs saved by a durable worker export. */
  export interface WorkerCapnpDurableOptions<
    I extends CapnpServerInterface,
    E extends SandstormEnv = SandstormEnv,
  > {
    restore(
      objectId: unknown,
      context: WorkerCapnpCallContext<E>,
    ): WorkerCapnpServerTargetFor<I, E> | WorkerCapnpRestoredClient |
      Promise<WorkerCapnpServerTargetFor<I, E> | WorkerCapnpRestoredClient>;
    drop(objectId: unknown, context: WorkerCapnpCallContext<E>): void | Promise<void>;
  }

  /** A generated capnp-es client returned by a registry for an arbitrary child interface. */
  export interface WorkerCapnpRestoredClient {
    readonly client: { call(request: unknown): unknown };
  }

  /** Declares a generated server target as one worker capability. */
  export function serveCapnp<
    I extends CapnpServerInterface,
    E extends SandstormEnv = SandstormEnv,
  >(
    InterfaceClass: I,
    target: WorkerCapnpServerTargetFor<I, E>,
    options?: WorkerCapnpDurableOptions<I, E>,
  ): WorkerCapnpExport<I, E>;

  export interface SandstormWorkerDefinition<E extends SandstormEnv = SandstormEnv> {
    readonly capabilities?: Readonly<Record<string, WorkerCapnpExport<any, E>>>;
  }

  export interface DefinedSandstormWorker {}

  /** Builds the default workerd export and installs Sandstorm's private RPC event handler. */
  export function defineWorker<E extends SandstormEnv = SandstormEnv>(
    definition: SandstormWorkerDefinition<E>,
  ): Readonly<DefinedSandstormWorker>;

  export interface MainViewFromFetchOptions<E extends SandstormEnv = SandstormEnv> {
    readonly viewInfo: object;
    fetch(
      request: Request,
      env: E,
      ctx: WorkerExecutionContext,
    ): Response | Promise<Response>;
    webSocket?(
      request: Request,
      socket: SandstormWebSocket,
      env: E,
      ctx: WorkerExecutionContext,
    ): SandstormWebSocketHandler<E> | Promise<SandstormWebSocketHandler<E>>;
    restore?(
      objectId: unknown,
      context: WorkerCapnpCallContext<E>,
    ): WorkerCapnpRestoredClient | Promise<WorkerCapnpRestoredClient>;
    drop?(objectId: unknown, context: WorkerCapnpCallContext<E>): void | Promise<void>;
  }

  export interface SandstormWebSocket {
    readonly closed: boolean;
    send(message: string | ArrayBuffer | ArrayBufferView): Promise<void>;
    close(code?: number, reason?: string): Promise<void>;
  }

  export interface SandstormWebSocketMessageEvent {
    readonly type: "text" | "data";
    readonly data: string | Uint8Array;
  }

  export interface SandstormWebSocketCloseEvent {
    readonly code: number;
    readonly reason: string;
  }

  export interface SandstormWebSocketHandler<E extends SandstormEnv = SandstormEnv> {
    readonly protocol?: string;
    message(
      event: SandstormWebSocketMessageEvent,
      socket: SandstormWebSocket,
      env: E,
      ctx: WorkerExecutionContext,
    ): void | Promise<void>;
    close?(
      event: SandstormWebSocketCloseEvent,
      socket: SandstormWebSocket,
      env: E,
      ctx: WorkerExecutionContext,
    ): void | Promise<void>;
  }

  /** Implements MainView/WebSession in capnp-es and adapts those UI calls to Fetch. */
  export function mainViewFromFetch<E extends SandstormEnv = SandstormEnv>(
    options: MainViewFromFetchOptions<E>,
  ): WorkerCapnpExport<CapnpServerInterface, E>;

  export interface WorkerSessionFromFetchOptions<E extends SandstormEnv = SandstormEnv> {
    readonly pathPrefix?: string;
    readonly label?: string;
    fetch(
      request: Request,
      env: E,
      ctx: WorkerExecutionContext,
    ): Response | Promise<Response>;
    webSocket?(
      request: Request,
      socket: SandstormWebSocket,
      env: E,
      ctx: WorkerExecutionContext,
    ): SandstormWebSocketHandler<E> | Promise<SandstormWebSocketHandler<E>>;
  }

  /** Declares a named, durable WebSession export backed by an explicit Fetch facade. */
  export function webSessionFromFetch<E extends SandstormEnv = SandstormEnv>(
    options: WorkerSessionFromFetchOptions<E>,
  ): WorkerCapnpExport<CapnpServerInterface, E>;

  /** Declares a named, durable ApiSession export backed by an explicit Fetch facade. */
  export function apiSessionFromFetch<E extends SandstormEnv = SandstormEnv>(
    options: WorkerSessionFromFetchOptions<E>,
  ): WorkerCapnpExport<CapnpServerInterface, E>;

  /**
   * Creates a non-owning schema view of a live Sandstorm capability. The returned
   * client does not own or extend the capability lifetime; its caller must drop the
   * original Capability when finished.
   */
  export function capnpClient<I extends CapnpClientInterface>(
    InterfaceClass: I,
    capability: Capability,
  ): ClientFor<I>;

  export interface CapnpBrowserHandoff {
    readonly type: "capability";
    readonly id: string;
    readonly kind: "receiverHosted";
    readonly residence: "browserHandoff";
    readonly interfaceId: string;
    readonly interfaceName: string;
  }

  /** Owns a local exported server and its generated client until drop() is called. */
  export interface CapnpExport<TClient> {
    readonly client: TClient;

    /** Persists this authority and returns its durable string token. */
    save(options?: SaveCapabilityOptions): Promise<string>;

    /** Releases the local server. This operation is idempotent. */
    drop(): Promise<void>;

    /**
     * Transfers this authority to the browser session identified by request. The
     * request must belong to a live Sandstorm WebSession.
     */
    browserHandoff(request: Request): Promise<CapnpBrowserHandoff>;
  }

  /** Exports a generated server target as live local Cap'n Proto authority. */
  export function exportCapnp<I extends CapnpServerInterface>(
    api: SandstormApi,
    InterfaceClass: I,
    target: ServerTargetFor<I>,
  ): Promise<CapnpExport<ClientFor<I>>>;

  /** Creates a new generated struct and applies its inferred Init<T> value. */
  export function createCapnpStruct<S extends CapnpStructClass>(
    StructClass: S,
    value?: StructInitFor<S>,
  ): InstanceType<S>;

  /** Reads an unknown pointer value as the requested generated struct type. */
  export function readCapnpStruct<S extends CapnpStructClass>(
    StructClass: S,
    value: unknown,
  ): InstanceType<S>;

  export type ByteStreamChunk =
    | Uint8Array
    | ArrayBuffer
    | ArrayBufferView
    | { toUint8Array(): Uint8Array }
    | { copyToUint8Array(): Uint8Array };

  /** Narrow generated sandstorm.util.ByteStream client contract. */
  export interface ByteStreamClient {
    write(params: { readonly data: ByteStreamChunk }): Promise<unknown> | unknown;
    done(params?: unknown): Promise<unknown> | unknown;
    expectSize?(params: { readonly size: bigint | number }): Promise<unknown> | unknown;
    drop?(reason?: unknown): Promise<unknown> | unknown;
  }

  export interface WritableFromByteStreamOptions {
    /** Total number of bytes that will be written. */
    readonly size?: bigint | number;
    /** Reject after writing more than this many bytes. */
    readonly maxBytes?: bigint | number;
    readonly chunkSize?: number;
  }

  export interface ByteStreamFromWritableOptions {
    readonly chunkSize?: number;
    /** `remaining` is the number of bytes expected after bytes already written. */
    readonly onExpectSize?: (
      remaining: bigint,
      context: {
        readonly expectedSize: bigint;
        readonly bytesWritten: bigint;
      },
    ) => Promise<void> | void;
  }

  /**
   * Adapts a ByteStream client to a WritableStream. close() calls done(); abort()
   * drops the ByteStream capability when the generated client supports drop().
   */
  export function writableFromByteStream(
    stream: ByteStreamClient,
    options?: WritableFromByteStreamOptions,
  ): WritableStream<ByteStreamChunk>;

  /** Pipes a ReadableStream into a ByteStream client and completes it. */
  export function pipeReadableToByteStream(
    readable: ReadableStream<ByteStreamChunk>,
    stream: ByteStreamClient,
    options?: WritableFromByteStreamOptions,
  ): Promise<void>;

  /**
   * Adapts a WritableStream to a ByteStream client. done() closes and releases the
   * writer; write/size failures abort it and release the writer lock.
   */
  export function byteStreamFromWritable(
    writable: WritableStream<Uint8Array>,
    options?: ByteStreamFromWritableOptions,
  ): ByteStreamClient;

  /** The isolate runtime cannot provide the requested Cap'n Proto operation. */
  export class CapnpUnavailableError extends Error {
    readonly name: "CapnpUnavailableError";
    readonly details: unknown;
    constructor(message: string, details?: unknown);
  }
}
