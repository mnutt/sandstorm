// Native destinations are an explicit projection, never inferred from arbitrary
// legacy URLs. An app-supplied path must remain inside its own grain route.
export function nativeNotificationPath(notification) {
  if (!notification.grainId) return notification.appUpdates ? "/install" : "";
  const id = notification.grainId;
  const path = notification.path ?? "";
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id) ||
      typeof path !== "string" || /[\\\u0000-\u001f\u007f]/.test(path)) return "";
  const base = "/grain/" + id;
  const url = new URL(base + (path ? "/" + path.replace(/^\/+/, "") : ""), "https://shell.invalid");
  if (url.pathname !== base && !url.pathname.startsWith(base + "/")) return "";
  const target = url.pathname + url.search + url.hash;
  return target;
}

export function nativeNotificationAction(notification) {
  if (notification.grainId || notification.appUpdates) return "";
  if (notification.admin) return notification.admin.type === "reportStats" ? "stats" : "";
  if (notification.referral) return "referrals";
  if (notification.identityChanges) return "identity";
  return "";
}
