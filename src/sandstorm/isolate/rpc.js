import capnwebSource from "sandstorm:capnweb-source";
import { newHttpBatchRpcSession } from "capnweb";

export {
  RpcPromise,
  RpcSession,
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

export function newSandstormRpcSession(url = "./rpc", options) {
  return newHttpBatchRpcSession(url, options);
}

export function browserClientScript() {
  return `${capnwebSource}

export function newSandstormRpcSession(url = "./rpc", options) {
  return newHttpBatchRpcSession(url, options);
}
`;
}
