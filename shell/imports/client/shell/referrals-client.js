import { Meteor } from "meteor/meteor";
import { Template } from "meteor/templating";

import { globalDb } from "/imports/db-deprecated";

import "/imports/client/shell/styles/referrals-page-ui.scss";
import "/imports/client/shell/styles/referrals-header-ui.scss";
import "/imports/client/shell/styles/referrals-content-ui.scss";
import "/imports/client/shell/styles/referrals-tutorial-ui.scss";
import "/imports/client/shell/styles/referrals-fine-print-ui.scss";

export const ReferralInfo = new Meteor.Collection("referralInfo"); // pseudo-collection
globalThis.ReferralInfo = ReferralInfo;

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
