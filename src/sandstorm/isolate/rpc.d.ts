declare module "sandstorm:rpc" {
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
