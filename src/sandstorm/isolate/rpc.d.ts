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
    query?: string[],
    options?: { saveLabel?: { defaultText: string } },
  ): Promise<{ token: string; descriptor?: string }>;
  export function browserClientScript(): string;
}
