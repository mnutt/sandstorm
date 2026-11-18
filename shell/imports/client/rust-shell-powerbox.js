import { Meteor } from "meteor/meteor";
import { Template } from "meteor/templating";
import { ReactiveVar } from "meteor/reactive-var";
import { Router } from "meteor/vlasky:galvanized-iron-router";
import { globalDb } from "/imports/db-deprecated";
import { GrainView } from "/imports/client/grain/grainview";
import { SandstormPowerboxRequest } from "/imports/sandstorm-ui-powerbox/powerbox-client";
import "./rust-shell-powerbox.html";
import "./rust-shell-powerbox.scss";

Router.route("/rust-shell-powerbox", function () { this.render("rustShellPowerbox"); }, { name: "rustShellPowerbox" });
Template.rustShellPowerbox.onCreated(function () {
  const instance = this;
  const origin = Meteor.settings.public.rustShellOrigin;
  const opener = window.opener;
  instance.request = new ReactiveVar(null);
  instance.error = new ReactiveVar("");
  let accepted = false;
  let closed = false;
  let nonce;
  let rpcId;
  let account;
  let contextInput;
  let validating = false;
  const finish = (result) => {
    if (closed) return;
    closed = true;
    opener?.postMessage({ type: "rust-powerbox-result", nonce, result }, origin);
    instance.request.get()?.finalize();
    instance.request.set(null);
  };
  const validate = async () => {
    if (Meteor.userId() !== account) throw new Error("The signed-in account changed.");
    return Meteor.callAsync("rustShellPowerboxContext", contextInput.sessionId, contextInput.request);
  };
  const send = (result) => {
    if (closed) return;
    if (!result.token) { finish(result); return; }
    // Recheck before transferring a capability if the chooser outlived its lease.
    validate().then(() => finish(result), error => finish({ rpcId, error: error.reason || error.message }));
  };
  instance.cancel = () => { send({ rpcId, canceled: true }); window.close(); };
  instance.receive = async (event) => {
    if (closed || accepted || !origin || !opener || event.origin !== origin || event.source !== opener ||
        event.data?.type !== "rust-powerbox-request") return;
    accepted = true;
    const data = event.data;
    nonce = data.nonce;
    rpcId = data.request?.rpcId;
    account = Meteor.userId();
    contextInput = data;
    try {
      if (typeof nonce !== "string" || nonce.length > 128) throw new Error("Invalid request.");
      const context = await Meteor.callAsync("rustShellPowerboxContext", data.sessionId, data.request);
      if (closed) return;
      if (Meteor.userId() !== account) throw new Error("The signed-in account changed.");
      instance.request.set(new SandstormPowerboxRequest(globalDb, {
        ...data.request, query: data.request.query, sessionId: data.sessionId, grainId: context.grainId,
        source: { postMessage: send }, origin,
        onCompleted: () => {},
      }, GrainView));
    } catch (error) {
      instance.error.set(error.reason || error.message);
      send({ rpcId, error: error.reason || error.message });
    }
  };
  instance.autorun(() => {
    const current = Meteor.userId();
    if (accepted && current !== account) instance.cancel();
  });
  window.addEventListener("message", instance.receive);
  instance.beforeUnload = () => send({ rpcId, canceled: true });
  window.addEventListener("beforeunload", instance.beforeUnload);
  instance.leaseTimer = setInterval(async () => {
    if (closed || !accepted || !instance.request.get() || validating) return;
    validating = true;
    try { await validate(); }
    catch (error) { finish({ rpcId, error: error.reason || error.message }); }
    finally { validating = false; }
  }, 5000);
  instance.timer = setInterval(() => {
    if (opener?.closed) instance.cancel();
    else if (!accepted && origin && opener) opener.postMessage({ type: "rust-powerbox-ready" }, origin);
  }, 500);
});
Template.rustShellPowerbox.onDestroyed(function () {
  clearInterval(this.timer);
  clearInterval(this.leaseTimer);
  window.removeEventListener("message", this.receive);
  window.removeEventListener("beforeunload", this.beforeUnload);
  this.beforeUnload();
});
Template.rustShellPowerbox.helpers({
  request: () => Template.instance().request,
  ready: () => !!Template.instance().request.get(),
  error: () => Template.instance().error.get(),
});
Template.rustShellPowerbox.events({
  "click .cancel-rust-powerbox"(event, instance) { event.preventDefault(); instance.cancel(); },
});
