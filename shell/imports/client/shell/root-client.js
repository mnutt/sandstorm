import { Meteor } from "meteor/meteor";
import { Template } from "meteor/templating";

import { prettySize } from "/imports/client/shell/formatting";
import { globalDb } from "/imports/db-deprecated";

import "/imports/client/shell/styles/root-ui.scss";

Template.root.helpers({
  storageUsage: function () {
    return Meteor.userId() ? prettySize(Meteor.user().storageUsage || 0) : undefined;
  },

  storageQuota: function () {
    const plan = globalDb.getMyPlan();
    return plan ? prettySize(plan.storage) : undefined;
  },

  overQuota: function () {
    return !Meteor.settings.public.stripePublicKey && globalThis.isUserOverQuota(Meteor.user());
  },
});
