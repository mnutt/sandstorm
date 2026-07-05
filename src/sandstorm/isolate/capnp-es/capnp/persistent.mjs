import { P as Pipeline, R as Registry, I as Interface } from '../shared/capnp-es.2NJr_hdR.mjs';
import { O as ObjectSize, S as Struct, a as adopt, d as disown, i as isNull, c as copyFrom } from '../shared/capnp-es.Da9bkTPj.mjs';
import { g as getPointer } from '../shared/capnp-es.iydqJhtG.mjs';
import { S as Server } from '../shared/capnp-es.BLGTYa4t.mjs';
import '../shared/capnp-es.Da2a44Ii.mjs';
import './rpc.mjs';
import '../shared/capnp-es.CKgVaTmi.mjs';

const _capnpFileId = 0xb8630836983feed7n;
class Persistent_SaveParams extends Struct {
  static _capnp = {
    displayName: "SaveParams",
    id: "f76fba59183073a5",
    typeId: 0xf76fba59183073a5n,
    typeIdHex: "f76fba59183073a5",
    size: new ObjectSize(0, 1),
    fields: [
      { name: "sealFor", codeOrder: 0, ordinal: 0, kind: "slot", offset: 0, type: { kind: "anyPointer" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["sealFor"];
      if (value2 !== void 0) {
        target.sealFor = value2;
      }
    }
  }
  _adoptSealFor(value) {
    adopt(value, getPointer(0, this));
  }
  _disownSealFor() {
    return disown(this.sealFor);
  }
  /**
  * Seal the SturdyRef so that it can only be restored by the specified Owner. This is meant
  * to mitigate damage when a SturdyRef is leaked. See comments above.
  *
  * Leaving this value null may or may not be allowed; it is up to the realm to decide. If a
  * realm does allow a null owner, this should indicate that anyone is allowed to restore the
  * ref.
  *
  */
  get sealFor() {
    return getPointer(0, this);
  }
  _hasSealFor() {
    return !isNull(getPointer(0, this));
  }
  set sealFor(value) {
    copyFrom(value, getPointer(0, this));
  }
  toString() {
    return "Persistent_SaveParams_" + super.toString();
  }
}
class Persistent_SaveResults extends Struct {
  static _capnp = {
    displayName: "SaveResults",
    id: "b76848c18c40efbf",
    typeId: 0xb76848c18c40efbfn,
    typeIdHex: "b76848c18c40efbf",
    size: new ObjectSize(0, 1),
    fields: [
      { name: "sturdyRef", codeOrder: 0, ordinal: 0, kind: "slot", offset: 0, type: { kind: "anyPointer" } }
    ]
  };
  static _applyInit(target, value) {
    const init = value;
    {
      const value2 = init["sturdyRef"];
      if (value2 !== void 0) {
        target.sturdyRef = value2;
      }
    }
  }
  _adoptSturdyRef(value) {
    adopt(value, getPointer(0, this));
  }
  _disownSturdyRef() {
    return disown(this.sturdyRef);
  }
  get sturdyRef() {
    return getPointer(0, this);
  }
  _hasSturdyRef() {
    return !isNull(getPointer(0, this));
  }
  set sturdyRef(value) {
    copyFrom(value, getPointer(0, this));
  }
  toString() {
    return "Persistent_SaveResults_" + super.toString();
  }
}
class Persistent_SaveResults$Promise {
  pipeline;
  constructor(pipeline) {
    this.pipeline = pipeline;
  }
  async promise() {
    return await this.pipeline.struct();
  }
  then(onfulfilled, onrejected) {
    return this.promise().then(onfulfilled, onrejected);
  }
  catch(onrejected) {
    return this.promise().catch(onrejected);
  }
  finally(onfinally) {
    return this.promise().finally(onfinally ?? void 0);
  }
}
class Persistent$Client {
  client;
  static interfaceId = 0xc8cb212fcd9f5691n;
  constructor(client) {
    this.client = client;
  }
  static methods = [
    {
      ParamsClass: Persistent_SaveParams,
      ResultsClass: Persistent_SaveResults,
      interfaceId: Persistent$Client.interfaceId,
      methodId: 0,
      interfaceName: "persistent.capnp:Persistent",
      methodName: "save",
      paramFields: Persistent_SaveParams._capnp.fields,
      resultFields: Persistent_SaveResults._capnp.fields
    }
  ];
  save(params) {
    const answer = this.client.call({
      method: Persistent$Client.methods[0],
      paramsFunc: params === void 0 ? void 0 : typeof params === "function" ? params : (target) => Persistent_SaveParams._applyInit(target, params)
    });
    const pipeline = new Pipeline(Persistent_SaveResults, answer);
    return new Persistent_SaveResults$Promise(pipeline);
  }
}
Registry.register(Persistent$Client.interfaceId, Persistent$Client);
class Persistent$Server extends Server {
  target;
  constructor(target) {
    super(target, [
      {
        ...Persistent$Client.methods[0],
        impl: async (params, results) => {
          const value = await target.save(params, results);
          if (value !== void 0) {
            Persistent_SaveResults._applyInit(results, value);
          }
        }
      }
    ]);
    this.target = target;
  }
  client() {
    return new Persistent$Client(this);
  }
}
class Persistent extends Interface {
  static SaveParams = Persistent_SaveParams;
  static SaveResults = Persistent_SaveResults;
  static Client = Persistent$Client;
  static Server = Persistent$Server;
  static _capnp = {
    displayName: "Persistent",
    id: "c8cb212fcd9f5691",
    typeId: 0xc8cb212fcd9f5691n,
    typeIdHex: "c8cb212fcd9f5691",
    size: new ObjectSize(0, 0),
    methods: Persistent$Client.methods
  };
  toString() {
    return "Persistent_" + super.toString();
  }
}

export { Persistent, Persistent$Client, Persistent$Server, Persistent_SaveParams, Persistent_SaveResults, Persistent_SaveResults$Promise, _capnpFileId };
