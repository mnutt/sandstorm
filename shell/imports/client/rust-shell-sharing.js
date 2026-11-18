import { Meteor } from "meteor/meteor";
import { Template } from "meteor/templating";
import { Router } from "meteor/vlasky:galvanized-iron-router";
import "./rust-shell-sharing.html";

// This handoff window owns the ordinary Meteor grain view and sharing dialogs.
// Its lifecycle outlives the waiting template when Router opens the grain.
export function installRustSharing(openDialog) {
  Router.route("/rust-shell-sharing", function () { this.render("rustShellSharing"); }, { name: "rustShellSharing" });
  Template.rustShellSharing.onCreated(function () {
    const origin = Meteor.settings.public.rustShellOrigin;
    const opener = window.opener;
    if (!origin || !opener) return;
    let request, account, context, busy = false, opened = false, stopped = false;
    const expires = Date.now() + 60000;
    let lastCheck = 0;
    const stop = () => {
      stopped = true;
      clearInterval(timer);
      removeEventListener("message", receive);
      removeEventListener("beforeunload", stop);
    };
    const fail = error => {
      opener.postMessage({ type: "rust-sharing-result", nonce: request?.nonce,
        error: error.reason || error.message || "Sharing session ended." }, origin);
      stop(); window.close();
    };
    const receive = async event => {
      if (stopped || request || event.source !== opener || event.origin !== origin || event.data?.type !== "rust-sharing-request") return;
      request = event.data;
      account = Meteor.userId();
      try {
        if (typeof request.nonce !== "string" || request.nonce.length > 128) throw new Error("Invalid sharing request.");
        context = await Meteor.callAsync("rustShellSharingContext", request.sessionId, request.mode, request.shareData);
        if (stopped) return;
        if (Meteor.userId() !== account) throw new Error("The signed-in account changed.");
        Router.go("/grain/" + encodeURIComponent(context.grainId));
      } catch (error) { fail(error); }
    };
    const timer = setInterval(async () => {
      if (stopped || busy) return;
      if (opener.closed) { stop(); window.close(); return; }
      if (!opened && Date.now() >= expires) { fail(new Error("Sharing request timed out.")); return; }
      if (!request) { opener.postMessage({ type: "rust-sharing-ready" }, origin); return; }
      if (Meteor.userId() !== account) { fail(new Error("The signed-in account changed.")); return; }
      if (!context) return;
      busy = true;
      try {
        if (Date.now() - lastCheck >= 5000) {
          await Meteor.callAsync("rustShellSharingContext", request.sessionId, request.mode, request.shareData);
          lastCheck = Date.now();
        }
        if (stopped) return;
        const grain = globalGrains.getActive();
        if (!opened && grain?.grainId() === context.grainId && grain.hasLoaded()) {
          // Recheck after the asynchronous validation before touching the UI.
          if (Meteor.userId() !== account) throw new Error("The signed-in account changed.");
          openDialog(grain, request.mode, request.shareData);
          opened = true;
          opener.postMessage({ type: "rust-sharing-result", nonce: request.nonce, opened: true }, origin);
        }
      } catch (error) { fail(error); }
      finally { busy = false; }
    }, 500);
    addEventListener("message", receive);
    addEventListener("beforeunload", stop);
  });
}
