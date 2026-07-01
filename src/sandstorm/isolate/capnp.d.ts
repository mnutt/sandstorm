declare module "capnp:*" {
  import type {
    Capability,
    RpcTarget,
    SaveCapabilityOptions,
  } from "sandstorm:api";

  export type CapnpRpcMethod = (...args: any[]) => unknown;
  export type CapnpMethodMap<TMethods> = {
    [K in keyof TMethods]: TMethods[K] extends CapnpRpcMethod ? TMethods[K] : never;
  };

  export type CapnpRpcClient<
    TMethods extends object = Record<string, CapnpRpcMethod>,
  > = {
    [K in keyof TMethods]: TMethods[K] extends (...args: infer Args) => infer Result
      ? (...args: Args) => Promise<Awaited<Result>>
      : never;
  };

  export type CapnpCapabilityClient<
    TMethods extends object = Record<string, CapnpRpcMethod>,
  > =
    CapnpRpcClient<TMethods> & {
      readonly capability: Capability;
      drop(): Promise<unknown>;
      save(options?: SaveCapabilityOptions): Promise<string>;
    };

  export interface CapnpInterfaceBinding<
    TMethods extends object = Record<string, CapnpRpcMethod>,
  > {
    readonly interfaceName: string;
    readonly schemaPath: string;
    readonly methodNames: readonly (keyof TMethods & string)[];
    implement(methods: CapnpMethodMap<TMethods>): RpcTarget;
    cast(capability: Capability): CapnpCapabilityClient<TMethods>;
    local(methods: CapnpMethodMap<TMethods>): CapnpRpcClient<TMethods>;
    powerboxDescriptor(options?: unknown): never;
  }

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
