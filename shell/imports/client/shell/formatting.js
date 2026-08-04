export const prettySize = function (size) {
  if (!size) return "";

  let suffix = "B";
  if (size >= 1000000000) {
    size = size / 1000000000;
    suffix = "GB";
  } else if (size >= 1000000) {
    size = size / 1000000;
    suffix = "MB";
  } else if (size >= 1000) {
    size = size / 1000;
    suffix = "kB";
  }

  return size.toPrecision(3) + suffix;
};
globalThis.prettySize = prettySize;
