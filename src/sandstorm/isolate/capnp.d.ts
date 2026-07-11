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
