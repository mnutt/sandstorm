import { M as Message } from './capnp-es.Da2a44Ii.mjs';
import { M as MethodError, c as copyCall, F as Fulfiller } from './capnp-es.2NJr_hdR.mjs';
import { E as ErrorAnswer } from './capnp-es.iydqJhtG.mjs';
import { R as RPC_METHOD_NOT_IMPLEMENTED } from './capnp-es.Da9bkTPj.mjs';

const disposeSymbol = Symbol.for("capnp-es.dispose");
class Server {
  constructor(target, methods) {
    this.target = target;
    this.methods = methods;
    for (const method of methods) {
      this.#methodsById.set(
        methodKey(method.interfaceId, method.methodId),
        method
      );
    }
  }
  #methodsById = /* @__PURE__ */ new Map();
  startCall(call) {
    const msg = new Message();
    const results = msg.initRoot(call.method.ResultsClass);
    void (async () => {
      try {
        await call.serverMethod.impl.call(this.target, call.params, results);
        call.answer.fulfill(results);
      } catch (error_) {
        try {
          call.answer.reject(error_);
        } catch {
        }
      }
    })();
  }
  call(call) {
    const serverMethod = this.#methodsById.get(
      methodKey(call.method.interfaceId, call.method.methodId)
    );
    if (!serverMethod) {
      return new ErrorAnswer(
        new MethodError(call.method, RPC_METHOD_NOT_IMPLEMENTED)
      );
    }
    const serverCall = {
      ...copyCall(call),
      answer: new Fulfiller(),
      serverMethod
    };
    this.startCall(serverCall);
    return serverCall.answer;
  }
  close() {
    const dispose = this.target?.[disposeSymbol];
    if (typeof dispose !== "function") {
      return;
    }
    try {
      void Promise.resolve(dispose.call(this.target)).catch(
        (error_) => {
          console.error("Error disposing capnp server target:", error_);
        }
      );
    } catch (error_) {
      console.error("Error disposing capnp server target:", error_);
    }
  }
}
function methodKey(interfaceId, methodId) {
  return `${interfaceId}:${methodId}`;
}

export { Server as S };
