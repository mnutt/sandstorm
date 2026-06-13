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

  export function browserClientScript(): string;
}
