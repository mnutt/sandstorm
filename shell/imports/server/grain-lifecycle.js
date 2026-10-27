import { Meteor } from "meteor/meteor";

export function assertGrainIsPublishable(grain) {
  if (!grain) {
    throw new Meteor.Error(404, "No such grain");
  }

  if (grain.trashed) {
    throw new Meteor.Error("grain-is-in-trash", "Grain is in the trash bin");
  }

  if (grain.suspended) {
    throw new Meteor.Error("grain-owner-suspended", "Grain owner is suspended");
  }
}
