import { N as ErrorClient, M as getInterfaceClientOrNull, k as getAs, E as ErrorAnswer, K as FixedAnswer } from './capnp-es.-PjN5D7P.mjs';
import { a9 as RPC_ZERO_REF, a6 as INVARIANT_UNREACHABLE_CODE, aa as RPC_FULFILL_ALREADY_CALLED, a5 as RPC_CALL_QUEUE_FULL, a7 as RPC_QUEUE_CALL_CANCEL, u as RPC_NULL_CLIENT, ab as RPC_IMPORT_CLOSED, ac as AnyStruct, ad as RPC_QUESTION_ID_REUSED, ae as RPC_NO_MAIN_INTERFACE, af as setInterfacePointer, ag as RPC_UNIMPLEMENTED, f as format, ah as RPC_RETURN_FOR_UNKNOWN_QUESTION, ai as RPC_BAD_TARGET, aj as RPC_UNKNOWN_CAP_DESCRIPTOR, ak as RPC_UNKNOWN_ANSWER_ID, al as RPC_UNKNOWN_EXPORT_ID } from './capnp-es.BylpbGNO.mjs';
import { t as transformPtr, a as toException, D as Deferred, Q as Queue, c as copyCall, F as Fulfiller, I as Interface, P as Pipeline, C as CapnpRpcError, M as MethodError, R as Registry, p as placeParams, b as PipelineClient } from './capnp-es.2t3WiX8T.mjs';
import { Message as Message$1, Disembargo_Context_Which, PromisedAnswer_Op, Resolve, CapDescriptor, Return, MessageTarget, Call_SendResultsTo_Which } from '../capnp/rpc.mjs';
import { M as Message } from './capnp-es.BC_cLggu.mjs';

function isSameClient(c, d) {
  const norm = (c2) => {
    return c2;
  };
  return norm(c) === norm(d);
}
function clientFromResolution(transform, obj, err) {
  if (err) {
    return new ErrorClient(err);
  }
  if (!obj) {
    return new ErrorClient(new Error(`null obj!`));
  }
  const out = transformPtr(obj, transform);
  return getInterfaceClientOrNull(out);
}

class IDGen {
  i = 0;
  free = [];
  next() {
    return this.free.pop() ?? this.i++;
  }
  remove(i) {
    this.free.push(i);
  }
}

class Ref {
  constructor(rc, finalize) {
    this.rc = rc;
    const closeState = { closed: false };
    this.closeState = closeState;
    finalize(this, () => {
      if (!closeState.closed) {
        closeState.closed = true;
        rc.decref();
      }
    });
  }
  closeState;
  call(cl) {
    return this.rc.call(cl);
  }
  client() {
    return this.rc._client;
  }
  close() {
    if (!this.closeState.closed) {
      this.closeState.closed = true;
      this.rc.decref();
    }
  }
}

class RefCount {
  refs;
  finalize;
  _client;
  constructor(c, _finalize) {
    this._client = c;
    this.finalize = _finalize;
    this.refs = 1;
  }
  // New creates a reference counter and the first client reference.
  static new(c, finalize) {
    const rc = new RefCount(c, finalize);
    const ref = rc.newRef();
    return [rc, ref];
  }
  call(cl) {
    return this._client.call(cl);
  }
  client() {
    return this._client;
  }
  close() {
    this._client.close();
  }
  ref() {
    if (this.refs <= 0) {
      return new ErrorClient(new Error(RPC_ZERO_REF));
    }
    this.refs++;
    return this.newRef();
  }
  newRef() {
    return new Ref(this, this.finalize);
  }
  decref() {
    this.refs--;
    if (this.refs === 0) {
      this._client.close();
    }
  }
}

function newMessage() {
  return new Message().initRoot(Message$1);
}
function newFinishMessage(questionID, release) {
  const m = newMessage();
  const f = m._initFinish();
  f.questionId = questionID;
  f.releaseResultCaps = release;
  return m;
}
function newUnimplementedMessage(m) {
  const n = newMessage();
  n.unimplemented = m;
  return n;
}
function newReturnMessage(id) {
  const m = newMessage();
  const ret = m._initReturn();
  ret.answerId = id;
  return m;
}
function newReleaseMessage(id, referenceCount) {
  const m = newMessage();
  const rel = m._initRelease();
  rel.id = id;
  rel.referenceCount = referenceCount;
  return m;
}
function newResolveMessage(id) {
  const m = newMessage();
  const res = m._initResolve();
  res.promiseId = id;
  return m;
}
function setResolveException(res, err) {
  const exc = res._initException();
  toException(exc, err);
  return exc;
}
function setReturnException(ret, err) {
  const exc = ret._initException();
  toException(exc, err);
  return exc;
}
function newDisembargoMessage(which, id) {
  const m = newMessage();
  const dis = m._initDisembargo();
  const ctx = dis._initContext();
  switch (which) {
    case Disembargo_Context_Which.SENDER_LOOPBACK: {
      ctx.senderLoopback = id;
      break;
    }
    case Disembargo_Context_Which.RECEIVER_LOOPBACK: {
      ctx.receiverLoopback = id;
      break;
    }
    default: {
      throw new Error(INVARIANT_UNREACHABLE_CODE);
    }
  }
  return m;
}

function transformToPromisedAnswer(answer, transform) {
  const opList = answer._initTransform(transform.length);
  for (const [i, op] of transform.entries()) {
    opList.get(i).getPointerField = op.field;
  }
}
function promisedAnswerOpsToTransform(list) {
  const transform = [];
  for (const op of list) {
    switch (op.which()) {
      case PromisedAnswer_Op.GET_POINTER_FIELD: {
        transform.push({
          field: op.getPointerField
        });
        break;
      }
      case PromisedAnswer_Op.NOOP: {
        break;
      }
    }
  }
  return transform;
}

var QuestionState = /* @__PURE__ */ ((QuestionState2) => {
  QuestionState2[QuestionState2["IN_PROGRESS"] = 0] = "IN_PROGRESS";
  QuestionState2[QuestionState2["RESOLVED"] = 1] = "RESOLVED";
  QuestionState2[QuestionState2["CANCELED"] = 2] = "CANCELED";
  return QuestionState2;
})(QuestionState || {});
class Question {
  constructor(conn, id, method) {
    this.conn = conn;
    this.id = id;
    this.method = method;
  }
  paramCaps = [];
  state = 0 /* IN_PROGRESS */;
  started = false;
  obj;
  err;
  derived = [];
  rootClosePending = false;
  deferred = new Deferred();
  struct() {
    return this.deferred.promise;
  }
  // start signals the question has been sent
  start() {
    this.started = true;
  }
  // fulfill is called to resolve a question successfully.
  // The caller must be holding onto q.conn.mu.
  fulfill(obj) {
    if (this.state !== 0 /* IN_PROGRESS */) {
      throw new Error(RPC_FULFILL_ALREADY_CALLED);
    }
    if (this.method) {
      this.obj = getAs(this.method.ResultsClass, obj);
    } else {
      this.obj = obj;
    }
    this.state = 1 /* RESOLVED */;
    this.deferred.resolve(this.obj);
  }
  // reject is called to resolve a question with failure
  reject(err) {
    if (!err) {
      throw new Error(`Question.reject called with null`);
    }
    if (this.state !== 0 /* IN_PROGRESS */) {
      throw new Error(`Question.reject called more than once`);
    }
    this.err = err;
    this.state = 1 /* RESOLVED */;
    this.deferred.reject(err);
  }
  // cancel is called to resolve a question with cancellation.
  cancel(err) {
    if (this.state === 0 /* IN_PROGRESS */) {
      if (this.conn.findQuestion(this.id)) {
        if (this.started) {
          const fin = newFinishMessage(this.id, true);
          this.conn.sendMessage(fin);
        }
        this.conn.popQuestion(this.id);
      }
      this.err = err;
      this.state = 2 /* CANCELED */;
      this.deferred.reject(err);
      return true;
    }
    return false;
  }
  pipelineCall(transform, call) {
    if (this.conn.findQuestion(this.id) !== this) {
      if (this.state === 0 /* IN_PROGRESS */) {
        throw new Error(`question popped but not done`);
      }
      const client = clientFromResolution(transform, this.obj, this.err);
      return client.call(call);
    }
    const pipeq = this.conn.newQuestion(call.method);
    try {
      const msg = newMessage();
      const msgCall = msg._initCall();
      msgCall.questionId = pipeq.id;
      msgCall.interfaceId = call.method.interfaceId;
      msgCall.methodId = call.method.methodId;
      const target = msgCall._initTarget();
      const a = target._initPromisedAnswer();
      a.questionId = this.id;
      transformToPromisedAnswer(a, transform);
      const payload = msgCall._initParams();
      pipeq.paramCaps = this.conn.fillParams(payload, call);
      this.conn.sendMessage(msg);
      pipeq.start();
      this.addPromise(transform);
      return pipeq;
    } catch (error_) {
      this.conn.popQuestion(pipeq.id);
      return new ErrorAnswer(error_);
    }
  }
  addPromise(transform) {
    for (const d of this.derived) {
      if (transformsEqual(transform, d)) {
        return;
      }
    }
    this.derived.push(transform);
  }
  pipelineClose(transform) {
    if (transform.length > 0) {
      this.derived = this.derived.filter((d) => !transformsEqual(transform, d));
      if (this.state === 0 /* IN_PROGRESS */) {
        if (this.rootClosePending && this.derived.length === 0 && this.closePendingRoot()) {
          return;
        }
        return;
      }
      try {
        clientFromResolution(transform, this.obj, this.err).close();
      } catch {
      }
      return;
    }
    if (this.derived.length > 0) {
      this.rootClosePending = true;
      return;
    }
    if (this.state === 0 /* IN_PROGRESS */) {
      this.closePendingRoot();
      return;
    }
    try {
      clientFromResolution(transform, this.obj, this.err).close();
    } catch {
    }
  }
  closePendingRoot() {
    if (this.state !== 0 /* IN_PROGRESS */) {
      return false;
    }
    if (this.conn.findQuestion(this.id)) {
      const fin = newFinishMessage(this.id, true);
      this.conn.sendMessage(fin);
      this.conn.popQuestion(this.id);
    }
    this.rootClosePending = false;
    this.err = new Error("pipeline closed");
    this.state = 2 /* CANCELED */;
    this.deferred.reject(this.err);
    return true;
  }
}
function transformsEqual(t, u) {
  if (t.length !== u.length) {
    return false;
  }
  for (const [i, element_] of t.entries()) {
    if (element_.field !== u[i].field) {
      return false;
    }
  }
  return true;
}

class Qcalls {
  constructor(data) {
    this.data = data;
  }
  static copyOf(data) {
    return new Qcalls([...data]);
  }
  len() {
    return this.data.length;
  }
  clear(i) {
    this.data[i] = null;
  }
  copy() {
    return Qcalls.copyOf(this.data);
  }
}

function joinAnswer(fl, answer) {
  Promise.resolve().then(() => answer.struct()).then((obj) => {
    try {
      fl.fulfill(obj);
    } catch {
    }
  }).catch((error_) => {
    try {
      fl.reject(error_);
    } catch {
    }
  });
}

const callQueueSize = 64;
class QueueClient {
  constructor(conn, client, calls) {
    this.conn = conn;
    this._client = client;
    this.calls = Qcalls.copyOf(calls);
    this.q = new Queue(this.calls, callQueueSize);
  }
  _client;
  calls;
  q;
  pushCall(call) {
    const f = new Fulfiller();
    try {
      call = copyCall(call);
    } catch (error_) {
      return new ErrorAnswer(error_);
    }
    const i = this.q.push();
    if (i === -1) {
      return new ErrorAnswer(new Error(RPC_CALL_QUEUE_FULL));
    }
    this.calls.data[i] = {
      call,
      f
    };
    return f;
  }
  pushEmbargo(id, tgt) {
    const i = this.q.push();
    if (i === -1) {
      throw new Error(RPC_CALL_QUEUE_FULL);
    }
    this.calls.data[i] = {
      embargoID: id,
      embargoTarget: tgt
    };
  }
  flushQueue() {
    let c = null;
    {
      const i = this.q.front();
      if (i !== -1) {
        c = this.calls.data[i];
      }
    }
    while (c) {
      this.handle(c);
      this.q.pop();
      {
        const i = this.q.front();
        c = i === -1 ? null : this.calls.data[i];
      }
    }
  }
  handle(c) {
    if (!c) {
      return;
    }
    if (isRemoteCall(c)) {
      const answer = this._client.call(c.call);
      joinAnswer(c.a, answer);
    } else if (isLocalCall(c)) {
      const answer = this._client.call(c.call);
      joinAnswer(c.f, answer);
    } else if (isDisembargo(c)) {
      const msg = newDisembargoMessage(
        Disembargo_Context_Which.RECEIVER_LOOPBACK,
        c.embargoID
      );
      msg.disembargo.target = c.embargoTarget;
      this.conn.sendMessage(msg);
    }
  }
  isPassthrough() {
    return this.q.len() === 0;
  }
  call(call) {
    if (this.isPassthrough()) {
      return this._client.call(call);
    }
    return this.pushCall(call);
  }
  // close releases any resources associated with this client.
  // No further calls to the client should be made after calling Close.
  close() {
    while (this.q.len() > 0) {
      const i = this.q.front();
      if (i === -1) {
        break;
      }
      const c = this.calls.data[i];
      if (c) {
        if (isRemoteCall(c)) {
          c.a.reject(new Error(RPC_QUEUE_CALL_CANCEL));
        } else if (isLocalCall(c)) {
          c.f.reject(new Error(RPC_QUEUE_CALL_CANCEL));
        }
      }
      this.q.pop();
    }
    this._client.close();
  }
}

class AnswerEntry {
  id;
  conn;
  resultCaps = [];
  sendResultsElsewhere = false;
  done = false;
  obj;
  err;
  deferred = new Deferred();
  queue = [];
  constructor(conn, id) {
    this.conn = conn;
    this.id = id;
    this.deferred.promise.catch(() => {
    });
  }
  // fulfill is called to resolve an answer successfully.
  fulfill(obj) {
    if (this.done) {
      throw new Error(`answer.fulfill called more than once`);
    }
    this.done = true;
    this.obj = obj;
    const retmsg = newReturnMessage(this.id);
    const ret = retmsg.return;
    ret.releaseParamCaps = false;
    if (this.sendResultsElsewhere) {
      ret.resultsSentElsewhere = true;
      this.deferred.resolve(obj);
      this.conn.fulfillTailAnswerWaiters(this.id, obj);
      this.conn.sendMessage(retmsg);
      return;
    }
    const payload = ret._initResults();
    payload.content = obj;
    let firstErr;
    try {
      this.conn.makeCapTable(ret.segment, (len) => payload._initCapTable(len));
      this.resultCaps = this.conn.collectPayloadSenderHosted(payload);
      this.deferred.resolve(obj);
      this.conn.fulfillTailAnswerWaiters(this.id, obj);
      this.conn.sendMessage(retmsg);
    } catch (error_) {
      if (!firstErr) {
        firstErr = error_;
      }
    }
    const [queues, queuesErr] = this.emptyQueue(obj);
    if (queuesErr && !firstErr) {
      firstErr = queuesErr;
    }
    const objcap = obj.segment.message._capnp;
    if (!objcap.capTable) {
      objcap.capTable = [];
    }
    const queueClients = [];
    for (const capIdxStr of Object.keys(queues)) {
      const capIdx = Number(capIdxStr);
      const q = queues[capIdx];
      if (objcap.capTable === null) throw new Error(INVARIANT_UNREACHABLE_CODE);
      const queueClient = new QueueClient(
        this.conn,
        objcap.capTable[capIdx],
        q
      );
      objcap.capTable[capIdx] = queueClient;
      queueClients.push(queueClient);
    }
    for (const queueClient of queueClients) {
      queueClient.flushQueue();
    }
    if (firstErr) {
      throw firstErr;
    }
  }
  // reject is called to resolve an answer with failure.
  reject(err) {
    if (!err) {
      throw new Error(`answer.reject called with nil`);
    }
    if (this.done) {
      throw new Error(`answer.reject claled more than once`);
    }
    const m = newReturnMessage(this.id);
    const mret = m.return;
    mret.releaseParamCaps = false;
    setReturnException(mret, err);
    this.err = err;
    this.done = true;
    this.deferred.reject(err);
    this.conn.rejectTailAnswerWaiters(this.id, err);
    let firstErr;
    try {
      this.conn.sendMessage(m);
    } catch (error_) {
      firstErr = error_;
    }
    for (let i = 0; i < this.queue.length; i++) {
      const qa = this.queue[i];
      try {
        if (qa.qcall && isRemoteCall(qa.qcall)) {
          qa.qcall.a.reject(err);
        }
      } catch (error_) {
        if (!firstErr) {
          firstErr = error_;
        }
      }
    }
    this.queue = [];
    if (firstErr) {
      throw firstErr;
    }
  }
  // emptyQueue splits the queue by which capability it targets
  // and drops any invalid calls. Once this function returns,
  // this.queue will be empty.
  emptyQueue(obj) {
    let firstErr;
    const qs = {};
    for (let i = 0; i < this.queue.length; i++) {
      const pc = this.queue[i];
      if (!isRemoteCall(pc.qcall)) {
        continue;
      }
      if (!pc.qcall.a) {
        continue;
      }
      let c;
      try {
        c = transformPtr(obj, pc.transform);
      } catch (error_) {
        try {
          pc.qcall.a.reject(error_);
        } catch (error_2) {
          if (!firstErr) {
            firstErr = error_2;
          }
        }
        continue;
      }
      const ci = Interface.fromPointer(c);
      if (!ci) {
        try {
          pc.qcall.a.reject(new Error(RPC_NULL_CLIENT));
        } catch (error_) {
          if (!firstErr) {
            firstErr = error_;
          }
        }
        continue;
      }
      const cn = ci.getCapId();
      if (!qs[cn]) {
        qs[cn] = [];
      }
      qs[cn].push(pc.qcall);
    }
    this.queue = [];
    return [qs, firstErr];
  }
  queueCall(call, transform, a) {
    if (this.queue.length >= callQueueSize) {
      throw new Error(RPC_CALL_QUEUE_FULL);
    }
    const qcall = {
      a,
      call: copyCall(call)
    };
    const pcall = {
      qcall,
      transform
    };
    this.queue.push(pcall);
  }
}
function isRemoteCall(a) {
  return !!a.a;
}
function isLocalCall(a) {
  return !!a.f;
}
function isDisembargo(a) {
  return !!a.embargoTarget;
}

class ImportClient {
  constructor(conn, id) {
    this.conn = conn;
    this.id = id;
  }
  closed = false;
  resolved;
  embargoId;
  embargoQueue = [];
  embargoQueueCap = 64;
  call(cl) {
    if (this.closed) {
      return new ErrorAnswer(new Error(RPC_IMPORT_CLOSED));
    }
    if (this.embargoId !== void 0 && this.resolved) {
      if (this.embargoQueue.length >= this.embargoQueueCap) {
        return new ErrorAnswer(new Error(RPC_CALL_QUEUE_FULL));
      }
      const f = new Fulfiller();
      this.embargoQueue.push({
        call: copyCall(cl),
        f
      });
      return f;
    }
    if (this.resolved) {
      return this.resolved.call(cl);
    }
    const q = this.conn.newQuestion(cl.method);
    try {
      const msg = newMessage();
      const msgCall = msg._initCall();
      msgCall.questionId = q.id;
      msgCall.interfaceId = cl.method.interfaceId;
      msgCall.methodId = cl.method.methodId;
      const target = msgCall._initTarget();
      target.importedCap = this.id;
      const payload = msgCall._initParams();
      q.paramCaps = this.conn.fillParams(payload, cl);
      this.conn.sendMessage(msg);
      q.start();
      return q;
    } catch (error_) {
      this.conn.popQuestion(q.id);
      return new ErrorAnswer(error_);
    }
  }
  setResolved(client) {
    if (this.closed) {
      client.close();
      return;
    }
    this.resolved?.close();
    this.resolved = client;
  }
  activateEmbargo(id) {
    this.embargoId = id;
  }
  liftEmbargo(id) {
    if (this.embargoId !== id) {
      return false;
    }
    this.embargoId = void 0;
    const resolved = this.resolved;
    if (!resolved) {
      return true;
    }
    for (const item of this.embargoQueue) {
      joinAnswer(item.f, resolved.call(item.call));
    }
    this.embargoQueue = [];
    return true;
  }
  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const item of this.embargoQueue) {
      try {
        item.f.reject(new Error(RPC_IMPORT_CLOSED));
      } catch {
      }
    }
    this.embargoQueue = [];
    this.embargoId = void 0;
    this.resolved?.close();
    this.conn.releaseImportAll(this.id);
  }
}

class LocalAnswerClient {
  constructor(a, transform) {
    this.a = a;
    this.transform = transform;
  }
  call(call) {
    if (this.a.done) {
      return clientFromResolution(this.transform, this.a.obj, this.a.err).call(
        call
      );
    }
    return new Fulfiller();
  }
  close() {
    if (this.a.done) {
      clientFromResolution(this.transform, this.a.obj, this.a.err).close();
    }
  }
}

const promiseExportQueueCap = 64;
class PromiseExportClient {
  resolved;
  closed = false;
  queue = [];
  queueCap = promiseExportQueueCap;
  call(call) {
    if (this.closed) {
      return new ErrorAnswer(new Error("promise export closed"));
    }
    if (!this.resolved) {
      if (this.queue.length >= this.queueCap) {
        return new ErrorAnswer(new Error(RPC_CALL_QUEUE_FULL));
      }
      const f = new Fulfiller();
      let copied;
      try {
        copied = copyCall(call);
      } catch (error_) {
        return new ErrorAnswer(error_);
      }
      this.queue.push({
        call: copied,
        f
      });
      return f;
    }
    return this.resolved.call(call);
  }
  resolve(client) {
    if (this.closed) {
      client.close();
      return;
    }
    this.resolved?.close();
    this.resolved = client;
    for (const item of this.queue) {
      joinAnswer(item.f, client.call(item.call));
    }
    this.queue = [];
  }
  reject(err) {
    for (const item of this.queue) {
      item.f.reject(err);
    }
    this.queue = [];
  }
  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.resolved?.close();
    this.reject(new Error("promise export closed"));
  }
}

const ConnWeakRefRegistry = globalThis.FinalizationRegistry ? new FinalizationRegistry((cb) => cb()) : void 0;
const ConDefaultFinalize = (obj, finalizer) => {
  ConnWeakRefRegistry?.register(obj, finalizer);
};
class Conn {
  /**
   * Create a new connection
   * @param transport The transport used to receive/send messages.
   * @param finalize Weak reference implementation. Compatible with
   * the 'weak' module on node.js (just add weak as a dependency and pass
   * require("weak")), but alternative implementations can be provided for
   * other platforms like Electron. Defaults to using FinalizationRegistry if
   * available.
   * @returns A new connection.
   */
  constructor(transport, finalize = ConDefaultFinalize) {
    this.transport = transport;
    this.finalize = finalize;
    this.startWork();
  }
  questionID = new IDGen();
  questions = [];
  answers = {};
  exportID = new IDGen();
  exports = [];
  imports = {};
  disembargoID = new IDGen();
  disembargoes = {};
  tailAnswerWaiters = {};
  exportPromises = {};
  exportPromiseIndex = /* @__PURE__ */ new WeakMap();
  onError;
  main;
  working = false;
  closed = false;
  bootstrap(InterfaceClass) {
    const q = this.newQuestion();
    const msg = newMessage();
    const boot = msg._initBootstrap();
    boot.questionId = q.id;
    this.sendMessage(msg);
    q.start();
    return new InterfaceClass.Client(new Pipeline(AnyStruct, q).client());
  }
  initMain(InterfaceClass, target) {
    this.main = new InterfaceClass.Server(target);
    this.addExport(this.main);
  }
  startWork() {
    this.work().catch((error_) => {
      if (this.onError) {
        this.onError(error_);
      } else if (error_ !== void 0) {
        throw error_;
      }
    });
  }
  sendReturnException(id, err) {
    const m = newReturnMessage(id);
    setReturnException(m.return, err);
    this.sendMessage(m);
  }
  handleBootstrapMessage(m) {
    const boot = m.bootstrap;
    const id = boot.questionId;
    const ret = newReturnMessage(id);
    ret.return.releaseParamCaps = false;
    const a = this.insertAnswer(id);
    if (a === null) {
      return this.sendReturnException(id, new Error(RPC_QUESTION_ID_REUSED));
    }
    if (this.main === void 0) {
      return a.reject(new Error(RPC_NO_MAIN_INTERFACE));
    }
    const msg = new Message();
    const capId = msg.addCap(this.main);
    const root = new Interface(msg.getSegment(0), 0);
    setInterfacePointer(capId, root);
    a.fulfill(root);
  }
  handleFinishMessage(m) {
    const { finish } = m;
    const id = finish.questionId;
    const a = this.popAnswer(id);
    if (a === null) {
      return;
    }
    if (finish.releaseResultCaps) {
      const caps = a.resultCaps;
      let i = caps.length;
      while (--i >= 0) {
        this.releaseExport(caps[i], 1);
      }
    }
  }
  handleResolveMessage(m) {
    const resolve = m.resolve;
    const promiseId = resolve.promiseId;
    const entry = this.imports[promiseId];
    if (!entry) {
      if (resolve.which() === Resolve.CAP) {
        try {
          this.discardResolvedCap(resolve.cap);
        } catch {
          this.sendMessage(newUnimplementedMessage(m));
        }
      }
      return;
    }
    const importClient = entry.rc._client;
    if (!(importClient instanceof ImportClient)) {
      throw new TypeError(INVARIANT_UNREACHABLE_CODE);
    }
    if (!entry.isPromise) {
      if (resolve.which() === Resolve.CAP) {
        try {
          this.discardResolvedCap(resolve.cap);
        } catch {
          this.sendMessage(newUnimplementedMessage(m));
        }
      }
      return;
    }
    switch (resolve.which()) {
      case Resolve.CAP: {
        const wasPromise = entry.isPromise;
        entry.isPromise = false;
        let client;
        try {
          client = this.clientFromCapDescriptor(resolve.cap);
        } catch (error_) {
          this.sendMessage(newUnimplementedMessage(m));
          importClient.setResolved(new ErrorClient(error_));
          break;
        }
        importClient.setResolved(client);
        if (wasPromise && this.capDescriptorNeedsSenderLoopback(resolve.cap)) {
          const embargoId = this.registerDisembargo(importClient);
          importClient.activateEmbargo(embargoId);
          const out = newDisembargoMessage(
            Disembargo_Context_Which.SENDER_LOOPBACK,
            embargoId
          );
          out.disembargo._initTarget().importedCap = promiseId;
          this.sendMessage(out);
        }
        break;
      }
      case Resolve.EXCEPTION: {
        entry.isPromise = false;
        importClient.setResolved(
          new ErrorClient(new CapnpRpcError(resolve.exception))
        );
        break;
      }
      default: {
        entry.isPromise = false;
        importClient.setResolved(new ErrorClient(new Error(RPC_UNIMPLEMENTED)));
      }
    }
  }
  capDescriptorNeedsSenderLoopback(desc) {
    return desc.which() === CapDescriptor.RECEIVER_HOSTED || desc.which() === CapDescriptor.RECEIVER_ANSWER;
  }
  handleReleaseMessage(m) {
    const rel = m.release;
    this.releaseExport(rel.id, rel.referenceCount);
  }
  handleDisembargoMessage(m) {
    const dis = m.disembargo;
    const ctx = dis.context;
    switch (ctx.which()) {
      case Disembargo_Context_Which.SENDER_LOOPBACK: {
        const out = newDisembargoMessage(
          Disembargo_Context_Which.RECEIVER_LOOPBACK,
          ctx.senderLoopback
        );
        out.disembargo.target = dis.target;
        this.sendMessage(out);
        break;
      }
      case Disembargo_Context_Which.RECEIVER_LOOPBACK: {
        const id = ctx.receiverLoopback;
        const client = this.disembargoes[id];
        if (!client) {
          break;
        }
        delete this.disembargoes[id];
        this.disembargoID.remove(id);
        client.liftEmbargo(id);
        break;
      }
      default: {
        this.sendMessage(newUnimplementedMessage(m));
      }
    }
  }
  handleMessage(m) {
    switch (m.which()) {
      case Message$1.UNIMPLEMENTED: {
        break;
      }
      case Message$1.BOOTSTRAP: {
        this.handleBootstrapMessage(m);
        break;
      }
      case Message$1.ABORT: {
        this.shutdown(new CapnpRpcError(m.abort));
        break;
      }
      case Message$1.FINISH: {
        this.handleFinishMessage(m);
        break;
      }
      case Message$1.RESOLVE: {
        this.handleResolveMessage(m);
        break;
      }
      case Message$1.RELEASE: {
        this.handleReleaseMessage(m);
        break;
      }
      case Message$1.DISEMBARGO: {
        this.handleDisembargoMessage(m);
        break;
      }
      case Message$1.OBSOLETE_SAVE:
      case Message$1.OBSOLETE_DELETE:
      case Message$1.PROVIDE:
      case Message$1.ACCEPT:
      case Message$1.JOIN: {
        this.sendMessage(newUnimplementedMessage(m));
        break;
      }
      case Message$1.RETURN: {
        this.handleReturnMessage(m);
        break;
      }
      case Message$1.CALL: {
        this.handleCallMessage(m);
        break;
      }
    }
  }
  handleReturnMessage(m) {
    const ret = m.return;
    const id = ret.answerId;
    const q = this.popQuestion(id);
    if (!q) {
      this.shutdown(new Error(format(RPC_RETURN_FOR_UNKNOWN_QUESTION, id)));
      return;
    }
    if (ret.releaseParamCaps) {
      for (let i = 0; i < q.paramCaps.length; i++) {
        this.releaseExport(q.paramCaps[i], 1);
      }
    }
    let releaseResultCaps = true;
    switch (ret.which()) {
      case Return.RESULTS: {
        releaseResultCaps = false;
        const { results } = ret;
        try {
          this.populateMessageCapTable(results);
        } catch (error_) {
          this.sendMessage(newUnimplementedMessage(m));
          q.reject(error_);
          break;
        }
        const { content } = results;
        q.fulfill(content);
        break;
      }
      case Return.EXCEPTION: {
        const exc = ret.exception;
        const err = q.method ? new MethodError(q.method, exc) : new CapnpRpcError(exc);
        q.reject(err);
        break;
      }
      case Return.CANCELED: {
        q.reject(new Error("call canceled by remote"));
        break;
      }
      case Return.TAKE_FROM_OTHER_QUESTION: {
        const otherQuestionId = ret.takeFromOtherQuestion;
        if (otherQuestionId === id) {
          q.reject(new Error(RPC_BAD_TARGET));
          break;
        }
        const source = this.answers[otherQuestionId];
        if (!source) {
          q.reject(new Error(RPC_BAD_TARGET));
          break;
        }
        if (source.done) {
          if (source.err) {
            q.reject(source.err);
          } else if (source.obj) {
            q.fulfill(source.obj);
          } else {
            q.reject(new Error(RPC_BAD_TARGET));
          }
          break;
        }
        if (!this.tailAnswerWaiters[otherQuestionId]) {
          this.tailAnswerWaiters[otherQuestionId] = [];
        }
        this.tailAnswerWaiters[otherQuestionId].push(q);
        break;
      }
      case Return.RESULTS_SENT_ELSEWHERE: {
        q.reject(new Error(RPC_UNIMPLEMENTED));
        break;
      }
    }
    if (!ret.noFinishNeeded) {
      const fin = newFinishMessage(id, releaseResultCaps);
      this.sendMessage(fin);
    }
  }
  handleCallMessage(m) {
    const mcall = m.call;
    const id = mcall.questionId;
    const mt = mcall.target;
    if (mt.which() !== MessageTarget.IMPORTED_CAP && mt.which() !== MessageTarget.PROMISED_ANSWER) {
      this.sendReturnException(id, new Error(RPC_BAD_TARGET));
      return;
    }
    const mparams = mcall.params;
    try {
      this.populateMessageCapTable(mparams);
    } catch (error_) {
      this.sendReturnException(id, error_);
      return;
    }
    const a = this.insertAnswer(id);
    if (!a) {
      this.shutdown(new Error(format(RPC_QUESTION_ID_REUSED, id)));
      return;
    }
    switch (mcall.sendResultsTo.which()) {
      case Call_SendResultsTo_Which.CALLER: {
        break;
      }
      case Call_SendResultsTo_Which.YOURSELF: {
        a.sendResultsElsewhere = true;
        break;
      }
      default: {
        this.popAnswer(id);
        this.sendReturnException(id, new Error(RPC_UNIMPLEMENTED));
        return;
      }
    }
    const interfaceDef = Registry.lookup(mcall.interfaceId);
    if (!interfaceDef) {
      this.popAnswer(id);
      this.sendReturnException(id, new Error(RPC_UNIMPLEMENTED));
      return;
    }
    const methodTable = "ownMethods" in interfaceDef ? interfaceDef.ownMethods : interfaceDef.methods;
    const method = methodTable[mcall.methodId];
    if (!method) {
      this.popAnswer(id);
      this.sendReturnException(id, new Error(RPC_UNIMPLEMENTED));
      return;
    }
    const paramContent = mparams.content;
    const call = {
      method,
      params: getAs(method.ParamsClass, paramContent)
    };
    try {
      this.routeCallMessage(a, mt, call);
    } catch (error_) {
      a.reject(error_);
    }
  }
  routeCallMessage(result, mt, cl) {
    switch (mt.which()) {
      case MessageTarget.IMPORTED_CAP: {
        const id = mt.importedCap;
        const e = this.findExport(id);
        if (!e) {
          throw new Error(RPC_BAD_TARGET);
        }
        const answer = this.call(e.client, cl);
        joinAnswer(result, answer);
        break;
      }
      case MessageTarget.PROMISED_ANSWER: {
        const mpromise = mt.promisedAnswer;
        const id = mpromise.questionId;
        if (id === result.id) {
          throw new Error(RPC_BAD_TARGET);
        }
        const pa = this.answers[id];
        if (!pa) {
          throw new Error(RPC_BAD_TARGET);
        }
        const mtrans = mpromise.transform;
        const transform = promisedAnswerOpsToTransform(mtrans);
        if (pa.done) {
          const { obj, err } = pa;
          const client = clientFromResolution(transform, obj, err);
          const answer = this.call(client, cl);
          joinAnswer(result, answer);
        } else {
          pa.queueCall(cl, transform, result);
        }
        break;
      }
      default: {
        throw new Error(INVARIANT_UNREACHABLE_CODE);
      }
    }
  }
  populateMessageCapTable(payload) {
    const msg = payload.segment.message;
    const ctab = payload.capTable;
    for (const desc of ctab) {
      switch (desc.which()) {
        case CapDescriptor.NONE: {
          msg.addCap(null);
          break;
        }
        case CapDescriptor.SENDER_HOSTED: {
          const id = desc.senderHosted;
          const client = this.addImport(id, false);
          msg.addCap(client);
          break;
        }
        case CapDescriptor.SENDER_PROMISE: {
          const id = desc.senderPromise;
          const client = this.addImport(id, true);
          msg.addCap(client);
          break;
        }
        case CapDescriptor.RECEIVER_HOSTED: {
          const id = desc.receiverHosted;
          const e = this.findExport(id);
          if (!e) {
            throw new Error(format(RPC_UNKNOWN_EXPORT_ID, id));
          }
          msg.addCap(e.rc.ref());
          break;
        }
        case CapDescriptor.RECEIVER_ANSWER: {
          const recvAns = desc.receiverAnswer;
          const id = recvAns.questionId;
          const a = this.answers[id];
          if (!a) {
            throw new Error(format(RPC_UNKNOWN_ANSWER_ID, id));
          }
          const recvTransform = recvAns.transform;
          const transform = promisedAnswerOpsToTransform(recvTransform);
          msg.addCap(answerPipelineClient(a, transform));
          break;
        }
        default: {
          throw new Error(format(RPC_UNKNOWN_CAP_DESCRIPTOR, desc.which()));
        }
      }
    }
  }
  addImport(id, isPromise = false) {
    const importEntry = this.imports[id];
    if (importEntry) {
      importEntry.refs++;
      importEntry.isPromise = importEntry.isPromise || isPromise;
      return importEntry.rc.ref();
    }
    const client = new ImportClient(this, id);
    const [rc, ref] = RefCount.new(client, this.finalize);
    this.imports[id] = {
      rc,
      refs: 1,
      isPromise
    };
    return ref;
  }
  releaseImport(id, refs) {
    const entry = this.imports[id];
    if (!entry) {
      return;
    }
    if (refs <= 0) {
      this.error(
        `warning: import ${id} release with non-positive count (${refs}) ignored`
      );
      return;
    }
    const heldRefs = entry.refs;
    const releaseCount = Math.max(0, Math.min(refs, heldRefs));
    entry.refs -= releaseCount;
    if (entry.refs > 0) {
      return;
    }
    if (refs > heldRefs) {
      this.error(
        `warning: import ${id} release overrun (requested ${refs}, held ${heldRefs})`
      );
    }
    this.clearDisembargo(entry.rc._client);
    delete this.imports[id];
    if (releaseCount > 0) {
      this.sendMessage(newReleaseMessage(id, releaseCount));
    }
  }
  releaseImportAll(id) {
    const entry = this.imports[id];
    if (!entry) {
      return;
    }
    this.releaseImport(id, entry.refs);
  }
  registerDisembargo(client) {
    const id = this.disembargoID.next();
    this.disembargoes[id] = client;
    return id;
  }
  clearDisembargo(client) {
    for (const [idStr, c] of Object.entries(this.disembargoes)) {
      if (c === client) {
        const id = Number(idStr);
        delete this.disembargoes[id];
        this.disembargoID.remove(id);
      }
    }
  }
  findExport(id) {
    if (id >= this.exports.length) {
      return null;
    }
    return this.exports[id];
  }
  addExport(client) {
    for (let i = 0; i < this.exports.length; i++) {
      const e = this.exports[i];
      if (e && isSameClient(e.rc._client, client)) {
        e.wireRefs++;
        return i;
      }
    }
    const id = this.exportID.next();
    const [rc, ref] = RefCount.new(client, this.finalize);
    const _export = {
      client: ref,
      id,
      rc,
      wireRefs: 1
    };
    if (id === this.exports.length) {
      this.exports.push(_export);
    } else {
      this.exports[id] = _export;
    }
    return id;
  }
  releaseExport(id, refs) {
    const e = this.findExport(id);
    if (!e) {
      return;
    }
    if (refs <= 0) {
      this.error(
        `warning: export ${id} release with non-positive count (${refs}) ignored`
      );
      return;
    }
    const heldRefs = e.wireRefs;
    const releaseCount = Math.max(0, Math.min(refs, heldRefs));
    e.wireRefs -= releaseCount;
    if (e.wireRefs > 0) {
      return;
    }
    if (refs > heldRefs) {
      this.error(
        `warning: export ${id} release overrun (requested ${refs}, held ${heldRefs})`
      );
    }
    delete this.exportPromises[id];
    e.client.close();
    this.exports[id] = null;
    this.exportID.remove(id);
  }
  error(s) {
    console.error(s);
  }
  newQuestion(method) {
    const id = this.questionID.next();
    const q = new Question(this, id, method);
    if (id === this.questions.length) {
      this.questions.push(q);
    } else {
      this.questions[id] = q;
    }
    return q;
  }
  findQuestion(id) {
    if (id >= this.questions.length) {
      return null;
    }
    return this.questions[id];
  }
  popQuestion(id) {
    const q = this.findQuestion(id);
    if (!q) {
      return q;
    }
    this.questions[id] = null;
    this.questionID.remove(id);
    return q;
  }
  // TODO: cancel context?
  insertAnswer(id) {
    if (this.answers[id]) {
      return null;
    }
    const a = new AnswerEntry(this, id);
    this.answers[id] = a;
    return a;
  }
  popAnswer(id) {
    const a = this.answers[id] ?? null;
    delete this.answers[id];
    return a;
  }
  shutdown(_err) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.working = false;
    const err = _err ?? new Error("connection closed");
    for (let i = 0; i < this.questions.length; i++) {
      const q = this.questions[i];
      if (!q) {
        continue;
      }
      if (q.state === QuestionState.IN_PROGRESS) {
        q.reject(err);
      }
      this.questions[i] = null;
      this.questionID.remove(i);
    }
    for (const idStr of Object.keys(this.answers)) {
      const id = Number(idStr);
      const a = this.answers[id];
      a.done = true;
      a.err = err;
      a.deferred.reject(err);
      delete this.answers[id];
    }
    for (let i = 0; i < this.exports.length; i++) {
      const e = this.exports[i];
      if (!e) {
        continue;
      }
      try {
        e.client.close();
      } catch {
      }
      this.exports[i] = null;
      this.exportID.remove(i);
    }
    this.exportPromises = {};
    this.exportPromiseIndex = /* @__PURE__ */ new WeakMap();
    for (const [idStr, entry] of Object.entries(this.imports)) {
      try {
        const c = entry.rc._client;
        if (c instanceof ImportClient) {
          c.closed = true;
          for (const item of c.embargoQueue) {
            try {
              item.f.reject(err);
            } catch {
            }
          }
          c.resolved?.close();
          c.resolved = void 0;
          c.embargoQueue = [];
          c.embargoId = void 0;
        }
      } catch {
      }
      delete this.imports[Number(idStr)];
    }
    for (const idStr of Object.keys(this.tailAnswerWaiters)) {
      const id = Number(idStr);
      const waiters = this.tailAnswerWaiters[id];
      for (const q of waiters) {
        if (q.state === QuestionState.IN_PROGRESS) {
          q.reject(err);
        }
      }
      delete this.tailAnswerWaiters[id];
    }
    for (const idStr of Object.keys(this.disembargoes)) {
      this.disembargoID.remove(Number(idStr));
    }
    this.disembargoes = {};
    this.transport.close();
  }
  call(client, call) {
    return client.call(call);
  }
  fillParams(payload, cl) {
    const params = placeParams(cl, payload.content);
    payload.content = params;
    this.makeCapTable(
      payload.segment,
      (length) => payload._initCapTable(length)
    );
    return this.collectPayloadSenderHosted(payload);
  }
  makeCapTable(s, init) {
    const msgtab = s.message._capnp.capTable;
    if (!msgtab) {
      return;
    }
    const t = init(msgtab.length);
    for (const [i, client] of msgtab.entries()) {
      const desc = t.get(i);
      if (!client) {
        desc.none = true;
        continue;
      }
      this.descriptorForClient(desc, client);
    }
  }
  collectPayloadSenderHosted(payload) {
    const out = [];
    for (const desc of payload.capTable) {
      if (desc.which() === CapDescriptor.SENDER_HOSTED) {
        out.push(desc.senderHosted);
      }
    }
    return out;
  }
  fulfillTailAnswerWaiters(id, value) {
    const waiters = this.tailAnswerWaiters[id];
    if (!waiters) {
      return;
    }
    delete this.tailAnswerWaiters[id];
    for (const waiter of waiters) {
      waiter.fulfill(value);
    }
  }
  rejectTailAnswerWaiters(id, err) {
    const waiters = this.tailAnswerWaiters[id];
    if (!waiters) {
      return;
    }
    delete this.tailAnswerWaiters[id];
    for (const waiter of waiters) {
      waiter.reject(err);
    }
  }
  clientFromCapDescriptor(desc) {
    switch (desc.which()) {
      case CapDescriptor.SENDER_HOSTED: {
        return this.addImport(desc.senderHosted, false);
      }
      case CapDescriptor.SENDER_PROMISE: {
        return this.addImport(desc.senderPromise, true);
      }
      case CapDescriptor.RECEIVER_HOSTED: {
        const id = desc.receiverHosted;
        const e = this.findExport(id);
        if (!e) {
          throw new Error(format(RPC_UNKNOWN_EXPORT_ID, id));
        }
        return e.rc.ref();
      }
      case CapDescriptor.RECEIVER_ANSWER: {
        const recvAns = desc.receiverAnswer;
        const id = recvAns.questionId;
        const a = this.answers[id];
        if (!a) {
          throw new Error(format(RPC_UNKNOWN_ANSWER_ID, id));
        }
        return answerPipelineClient(
          a,
          promisedAnswerOpsToTransform(recvAns.transform)
        );
      }
      default: {
        throw new Error(format(RPC_UNKNOWN_CAP_DESCRIPTOR, desc.which()));
      }
    }
  }
  discardResolvedCap(desc) {
    switch (desc.which()) {
      case CapDescriptor.SENDER_HOSTED: {
        this.sendMessage(newReleaseMessage(desc.senderHosted, 1));
        return;
      }
      case CapDescriptor.SENDER_PROMISE: {
        this.sendMessage(newReleaseMessage(desc.senderPromise, 1));
        return;
      }
      case CapDescriptor.RECEIVER_HOSTED: {
        const id = desc.receiverHosted;
        if (!this.findExport(id)) {
          throw new Error(format(RPC_UNKNOWN_EXPORT_ID, id));
        }
        return;
      }
      case CapDescriptor.RECEIVER_ANSWER: {
        const id = desc.receiverAnswer.questionId;
        if (!this.answers[id]) {
          throw new Error(format(RPC_UNKNOWN_ANSWER_ID, id));
        }
        return;
      }
      case CapDescriptor.NONE: {
        throw new Error(format(RPC_UNKNOWN_CAP_DESCRIPTOR, desc.which()));
      }
      default: {
        throw new Error(format(RPC_UNKNOWN_CAP_DESCRIPTOR, desc.which()));
      }
    }
  }
  // descriptorForClient fills desc for client, adding it to the export
  // table if necessary.  The caller must be holding onto c.mu.
  descriptorForClient(desc, _client) {
    {
      dig: for (let client = _client; ; ) {
        if (client instanceof ImportClient) {
          if (client.conn !== this) {
            break dig;
          }
          desc.receiverHosted = client.id;
          return;
        } else if (client instanceof Ref) {
          client = client.client();
        } else if (client instanceof PipelineClient) {
          const p = client.pipeline;
          const ans = p.answer;
          const transform = p.transform();
          if (ans instanceof FixedAnswer) {
            let s;
            let err;
            try {
              s = ans.structSync();
            } catch (error_) {
              err = error_;
            }
            client = clientFromResolution(transform, s, err);
          } else if (ans instanceof Question) {
            if (ans.state !== QuestionState.IN_PROGRESS) {
              client = clientFromResolution(transform, ans.obj, ans.err);
              continue;
            }
            if (ans.conn !== this) {
              const id2 = this.addExportPromise(ans, transform);
              desc.senderPromise = id2;
              return;
            }
            const a = desc._initReceiverAnswer();
            a.questionId = ans.id;
            transformToPromisedAnswer(a, p.transform());
            return;
          } else {
            break dig;
          }
        } else {
          break dig;
        }
      }
    }
    const id = this.addExport(_client);
    desc.senderHosted = id;
  }
  addExportPromise(question, transform) {
    const key = transform.map((op) => op.field).join(",");
    let indexed = this.exportPromiseIndex.get(question);
    if (!indexed) {
      indexed = /* @__PURE__ */ new Map();
      this.exportPromiseIndex.set(question, indexed);
    }
    const existingId = indexed.get(key);
    if (existingId !== void 0) {
      const existing = this.findExport(existingId);
      if (existing) {
        existing.wireRefs++;
        return existingId;
      }
      indexed.delete(key);
    }
    const promiseClient = new PromiseExportClient();
    const id = this.addExport(promiseClient);
    indexed.set(key, id);
    if (this.exportPromises[id]) {
      return id;
    }
    this.exportPromises[id] = {
      settled: false,
      client: promiseClient
    };
    const resolveFromQuestion = async () => {
      try {
        const obj = await question.struct();
        this.resolveExportPromiseCap(
          id,
          clientFromResolution(transform, obj, void 0)
        );
      } catch (error_) {
        this.resolveExportPromiseException(id, error_);
      }
    };
    void resolveFromQuestion();
    return id;
  }
  resolveExportPromiseCap(id, client) {
    const entry = this.exportPromises[id];
    if (!entry || entry.settled) {
      client.close();
      return;
    }
    entry.settled = true;
    entry.client.resolve(client);
    const m = newResolveMessage(id);
    this.descriptorForClient(m.resolve._initCap(), client);
    this.sendMessage(m);
  }
  resolveExportPromiseException(id, err) {
    const entry = this.exportPromises[id];
    if (!entry || entry.settled) {
      return;
    }
    entry.settled = true;
    entry.client.reject(err);
    const m = newResolveMessage(id);
    setResolveException(m.resolve, err);
    this.sendMessage(m);
  }
  sendMessage(msg) {
    this.transport.sendMessage(msg);
  }
  async work() {
    this.working = true;
    while (this.working) {
      try {
        const m = await this.transport.recvMessage();
        this.handleMessage(m);
      } catch (error_) {
        if (error_ !== void 0) {
          throw error_;
        }
        this.working = false;
      }
    }
  }
}
function answerPipelineClient(a, transform) {
  return new LocalAnswerClient(a, transform);
}

class DeferredTransport {
  d;
  closed = false;
  closeError;
  queue = [];
  close(err) {
    this.closed = true;
    this.closeError = err;
    this.queue = [];
    this.d?.reject(err);
    this.d = void 0;
  }
  recvMessage() {
    if (this.closed) {
      return Promise.reject(this.closeError);
    }
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift());
    }
    if (this.d) {
      this.d.reject();
    }
    this.d = new Deferred();
    return this.d.promise;
  }
  reject = (err) => {
    if (this.d) {
      this.d.reject(err);
      this.d = void 0;
    }
  };
  resolve = (buf) => {
    try {
      const msg = new Message(buf, false).getRoot(Message$1);
      if (this.d) {
        this.d.resolve(msg);
        this.d = void 0;
        return;
      }
      this.queue.push(msg);
    } catch (error_) {
      this.d?.reject(error_);
      this.d = void 0;
    }
  };
}

export { Conn as C, DeferredTransport as D, answerPipelineClient as a, clientFromResolution as c, isSameClient as i };
