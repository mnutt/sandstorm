// Collections backups cannot reconstruct their links to other grains.
export function grainBackupWarning(appId) {
  return appId === "s3u2xgmqwznz2n3apf30sm3gw1d85y029enw5pymx734cnk5n78h"
    ? "Backing up a collection does not back up any of its linked grains, " +
      "and restoring a collection does not automatically restore its links to grains. " +
      "Unless your goal is to debug a problem with this collection, downloading " +
      "a backup will not be very useful."
    : "";
}
