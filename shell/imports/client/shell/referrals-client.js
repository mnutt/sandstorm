import { Meteor } from "meteor/meteor";
import { Template } from "meteor/templating";

import { globalDb } from "/imports/db-deprecated";

import "/imports/client/shell/styles/referrals-ui.scss";

export const ReferralInfo = new Meteor.Collection("referralInfo"); // pseudo-collection

Template.referrals.helpers({
  setDocumentTitle: function () {
    document.title = "Referral Program · " + globalDb.getServerTitle();
  },

  isPaid: function () {
    return (Meteor.user() && Meteor.user().plan && Meteor.user().plan !== "free");
  },

  notYetCompleteReferralNames: function () {
    return ReferralInfo.find({ completed: false });
  },

  completeReferralNames: function () {
    return ReferralInfo.find({ completed: true });
  },
});
