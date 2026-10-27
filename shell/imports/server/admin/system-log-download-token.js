import { Random } from "meteor/random";

export const SYSTEM_LOG_DOWNLOAD_TOKEN_VALIDITY_DURATION = 60000;

const tokens = new Map();

export const SystemLogDownloadTokens = {
  issue(token = Random.id(22), now = Date.now()) {
    tokens.set(token, now);
    return token;
  },

  take(token, now = Date.now()) {
    if (typeof token !== "string") return null;

    const issueDate = tokens.get(token);
    if (!Number.isFinite(issueDate)) return null;

    tokens.delete(token);
    if (issueDate + SYSTEM_LOG_DOWNLOAD_TOKEN_VALIDITY_DURATION < now) {
      return null;
    }

    return issueDate;
  },

  remove(token) {
    tokens.delete(token);
  },

  clear() {
    tokens.clear();
  },
};
