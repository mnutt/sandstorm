import { Meteor } from "meteor/meteor";
import { Template } from "meteor/templating";
import { ReactiveVar } from "meteor/reactive-var";
import { Router } from "meteor/vlasky:galvanized-iron-router";
import "./rust-shell-login.html";

const state = () => new URL(location.href).searchParams.get("state") || "";
Router.route("/rust-shell-login", function () { this.render("rustShellLogin"); }, { name: "rustShellLogin" });
Template.rustShellLogin.onCreated(function () {
  this.busy = new ReactiveVar(false);
  this.error = new ReactiveVar("");
});
Template.rustShellLogin.helpers({
  enabled: () => !!Meteor.settings.public.rustShellOrigin && /^[a-f0-9]{64}$/.test(state()),
  accountName: () => Meteor.user()?.profile?.name || "your Sandstorm account",
  busy: () => Template.instance().busy.get(),
  error: () => Template.instance().error.get(),
});
Template.rustShellLogin.events({
  async "click .connect-rust-shell"(event, instance) {
    event.preventDefault();
    if (instance.busy.get()) return;
    instance.busy.set(true);
    instance.error.set("");
    const account = Meteor.userId();
    const nonce = state();
    try {
      const code = await Meteor.callAsync("createRustShellGrant", nonce);
      if (Meteor.userId() !== account) throw new Error("Account changed; please try again.");
      const form = document.createElement("form");
      form.method = "POST";
      form.action = Meteor.settings.public.rustShellOrigin + "/auth/login";
      for (const [name, value] of Object.entries({ code, state: nonce })) {
        const input = document.createElement("input");
        input.type = "hidden"; input.name = name; input.value = value; form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit(); // The one-use grant is never put in a URL, localStorage, or a cookie.
    } catch (error) {
      instance.error.set(error.reason || error.message);
      instance.busy.set(false);
    }
  },
});
