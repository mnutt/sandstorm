import { Meteor } from "meteor/meteor";

// Subscribe to basic grain information first and foremost, since
// without it we might e.g. redirect to the wrong place on login.
export const globalSubs = [
  Meteor.subscribe("grainsMenu"),
  Meteor.subscribe("userPackages"),
  Meteor.subscribe("devPackages"),
  Meteor.subscribe("credentials"),
  Meteor.subscribe("accountCredentials"),
];
