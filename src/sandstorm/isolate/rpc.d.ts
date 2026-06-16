declare module "sandstorm:rpc" {
  export const SANDSTORM_RPC_VERSION: 0;
  export const SANDSTORM_CAPNWEB_VERSION: "0.8.0";

  export {
    RpcPromise,
    RpcSession,
    RpcSessionOptions,
    RpcStub,
    RpcTarget,
    deserialize,
    newHttpBatchRpcResponse,
    newHttpBatchRpcSession,
    newMessagePortRpcSession,
    newWebSocketRpcSession,
    newWorkersRpcResponse,
    newWorkersWebSocketRpcResponse,
    serialize,
  } from "capnweb";

  export function newSandstormRpcSession<Remote = unknown>(
    url?: string,
    options?: import("capnweb").RpcSessionOptions,
  ): import("capnweb").RpcStub<Remote>;
  export function requestPowerbox(
    query?: string[] | null,
    options?: {
      saveLabel?: { defaultText: string };
    },
  ): Promise<{ token: string; descriptor?: string }>;
  export function claimPowerboxToken(
    token: string,
    options?: {
      claimUrl?: string;
      requiredPermissions?: string[];
    },
  ): Promise<{
    ok: true;
    type: "claimedCapability";
    id: string;
  }>;
  export function requestAndClaimPowerbox(
    query?: string[] | null,
    options?: {
      saveLabel?: { defaultText: string };
      claimUrl?: string;
      requiredPermissions?: string[];
    },
  ): Promise<{
    token: string;
    descriptor?: string;
    capability: {
      ok: true;
      type: "claimedCapability";
      id: string;
    };
  }>;
  export function apiSessionPowerboxDescriptor(options: {
    canonicalUrl: string;
    oauthScopes?: string[];
    descriptorUrl?: string;
  }): Promise<string>;
  export function apiSessionPowerboxDescriptorInfo(options: {
    canonicalUrl: string;
    oauthScopes?: string[];
    descriptorUrl?: string;
  }): Promise<{
    ok: true;
    type: "packedPowerboxDescriptor";
    descriptor: string;
    decoded?: {
      type: "apiSession";
      canonicalUrl: string;
      oauthScopes: string[];
    };
  }>;
  export function providerTagPowerboxDescriptor(options: {
    descriptor: string;
  }): string;
  export const powerboxDescriptors: {
    apiSession: typeof apiSessionPowerboxDescriptor;
    apiSessionInfo: typeof apiSessionPowerboxDescriptorInfo;
    providerTag: typeof providerTagPowerboxDescriptor;
  };
  export function inspectPowerboxQuery(
    query:
      | string
      | string[]
      | { descriptor?: string; descriptors?: string[] }
      | {
        canonicalUrl: string;
        oauthScopes?: string[];
        descriptorUrl?: string;
      }
      | {
        apiSession?: {
          canonicalUrl: string;
          oauthScopes?: string[];
          descriptorUrl?: string;
        };
        apiSessionDescriptor?: {
          canonicalUrl: string;
          oauthScopes?: string[];
          descriptorUrl?: string;
        };
      },
  ): Promise<{
    ok: true;
    type: "powerboxQueryInspection";
    descriptorCount: number;
    descriptors: Array<{
      index: number;
      type: string;
      descriptor: string;
      decoded?: {
        type: string;
        canonicalUrl?: string;
        oauthScopes?: string[];
      };
    }>;
  }>;
  export function requestProviderPowerbox(options: {
    descriptor?: string;
    descriptors?: string[];
    saveLabel?: { defaultText: string };
  }): Promise<{
    token: string;
    descriptor?: string;
  }>;
  export function requestProviderCapability(options: {
    descriptor?: string;
    descriptors?: string[];
    saveLabel?: { defaultText: string };
    claimUrl?: string;
    requiredPermissions?: string[];
  }): Promise<{
    token: string;
    descriptor?: string;
    capability: {
      ok: true;
      type: "claimedCapability";
      id: string;
    };
  }>;
  export function requestApiPowerbox(options: {
    canonicalUrl: string;
    oauthScopes?: string[];
    saveLabel?: { defaultText: string };
    descriptorUrl?: string;
  }): Promise<{
    token: string;
    descriptor?: string;
    powerboxDescriptor: {
      ok: true;
      type: "packedPowerboxDescriptor";
      descriptor: string;
    };
  }>;
  export function requestApiCapability(options: {
    canonicalUrl: string;
    oauthScopes?: string[];
    saveLabel?: { defaultText: string };
    descriptorUrl?: string;
    claimUrl?: string;
    requiredPermissions?: string[];
  }): Promise<{
    token: string;
    descriptor?: string;
    powerboxDescriptor: {
      ok: true;
      type: "packedPowerboxDescriptor";
      descriptor: string;
    };
    capability: {
      ok: true;
      type: "claimedCapability";
      id: string;
    };
  }>;
  export function browserClientScript(): string;
}
