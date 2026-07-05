declare module "sandstorm:capnp" {
  import type {
    Capability,
    RpcTarget,
    SaveCapabilityOptions,
  } from "sandstorm:api";

  export const SANDSTORM_CAPNP_VERSION: 0;

  export type CapnpRpcMethod = (...args: any[]) => unknown;
  export type CapnpMethodMap<TMethods> = {
    [K in keyof TMethods]: TMethods[K] extends CapnpRpcMethod ? TMethods[K] : never;
  };

  export type CapnpRpcClient<
    TMethods extends object = Record<string, CapnpRpcMethod>,
    TResultOverrides extends object = object,
  > = {
    [K in keyof TMethods]: TMethods[K] extends (...args: infer Args) => infer Result
      ? (...args: Args) => Promise<K extends keyof TResultOverrides
          ? TResultOverrides[K]
          : Awaited<Result>>
      : never;
  };

  export type CapnpCapabilityClient<
    TMethods extends object = Record<string, CapnpRpcMethod>,
    TResultOverrides extends object = object,
  > =
    CapnpRpcClient<TMethods, TResultOverrides> & {
      readonly capability: Capability;
      drop(): Promise<unknown>;
      save(options?: SaveCapabilityOptions): Promise<string>;
    };

  export type CapnpResultCapabilityBinding =
    CapnpInterfaceBinding<any, any> | (() => CapnpInterfaceBinding<any, any>);

  export type CapnpResultCapabilities<TMethods extends object> =
    Partial<Record<keyof TMethods & string, CapnpResultCapabilityBinding>>;

  export type CapnpArgumentCapabilities<TMethods extends object> =
    Partial<Record<keyof TMethods & string, {
      indexes?: readonly number[];
      indices?: readonly number[];
      fields?: readonly string[];
    }>>;

  export interface CapnpSchemaMetadata<TMethods extends object> {
    readonly importSpecifier: string;
    readonly interfaceName: string;
    readonly interfaceId: string;
    readonly schemaPath: string;
    readonly schemaText: string;
    readonly methodNames: readonly (keyof TMethods & string)[];
    readonly methodIds: Partial<Record<keyof TMethods & string, number>>;
    readonly paramStructIds: Partial<Record<keyof TMethods & string, string>>;
    readonly resultStructIds: Partial<Record<keyof TMethods & string, string>>;
    readonly argumentCapabilities: CapnpArgumentCapabilities<TMethods>;
    readonly resultCapabilities: CapnpResultCapabilities<TMethods>;
  }

  export interface CapnpInterfaceBinding<
    TMethods extends object = Record<string, CapnpRpcMethod>,
    TResultOverrides extends object = object,
  > {
    readonly interfaceName: string;
    readonly interfaceId: string;
    readonly schemaPath: string;
    readonly schema: CapnpSchemaMetadata<TMethods>;
    readonly methodNames: readonly (keyof TMethods & string)[];
    implement(methods: CapnpMethodMap<TMethods>): RpcTarget;
    cast(capability: Capability): CapnpCapabilityClient<TMethods, TResultOverrides>;
    local(methods: CapnpMethodMap<TMethods>): CapnpRpcClient<TMethods, TResultOverrides>;
    powerboxDescriptor(options?: unknown): never;
  }

  export function makeCapnpInterfaceBinding<
    TMethods extends object = Record<string, CapnpRpcMethod>,
    TResultOverrides extends object = object,
  >(
    interfaceName: string,
    methodNames: readonly (keyof TMethods & string)[],
    schema?: {
      importSpecifier?: string;
      interfaceId?: string;
      schemaPath?: string;
      schemaText?: string;
      methodIds?: Partial<Record<keyof TMethods & string, number>>;
      paramStructIds?: Partial<Record<keyof TMethods & string, string>>;
      resultStructIds?: Partial<Record<keyof TMethods & string, string>>;
      argumentCapabilities?: CapnpArgumentCapabilities<TMethods>;
      resultCapabilities?: CapnpResultCapabilities<TMethods>;
    },
  ): CapnpInterfaceBinding<TMethods, TResultOverrides>;
}

declare module "capnp:*" {
  import type { CapnpInterfaceBinding } from "sandstorm:capnp";

  export type {
    CapnpArgumentCapabilities,
    CapnpCapabilityClient,
    CapnpInterfaceBinding,
    CapnpMethodMap,
    CapnpSchemaMetadata,
    CapnpResultCapabilities,
    CapnpResultCapabilityBinding,
    CapnpRpcClient,
    CapnpRpcMethod,
  } from "sandstorm:capnp";

  export interface CapnpSchemaModule {
    readonly importSpecifier: string;
    readonly schemaPath: string;
    readonly schemaText: string;
    readonly interfaceNames: readonly string[];
    readonly [interfaceName: string]: unknown;
  }

  export const importSpecifier: string;
  export const schemaPath: string;
  export const schemaText: string;
  export const interfaceNames: readonly string[];

  const schema: CapnpSchemaModule;
  export default schema;
}
