import { SandstormDb } from "/imports/sandstorm-db/db";

// Call only with users already authorized by the enclosing projection. No lookup by browser ID.
export function rustUserPicture(user) {
  if (!user) return "";
  const projected = { ...user, profile: { ...user.profile } };
  SandstormDb.fillInPictureUrl(projected);
  return projected.profile.pictureUrl || "";
}
