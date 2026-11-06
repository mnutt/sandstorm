import Crypto from "crypto";

export function s3PayloadHash(body) {
  return Crypto.createHash("sha256").update(body).digest("hex");
}

function encode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g,
      char => "%" + char.charCodeAt(0).toString(16).toUpperCase());
}

// Sign only the final HTTP representation. Never normalize an S3 object's path.
// The outbound URL validator separately rejects keys incompatible with its scope rules.
export function signS3Request({ url, method, headers, payloadHash, credentials, now = new Date() }) {
  const target = new URL(url);
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = timestamp.slice(0, 8);
  const scope = `${date}/${credentials.region}/s3/aws4_request`;
  const signed = { ...headers, host: target.host,
    "x-amz-date": timestamp, "x-amz-content-sha256": payloadHash };
  if (credentials.sessionToken) signed["x-amz-security-token"] = credentials.sessionToken;

  const uri = target.pathname.split("/").map(part => encode(decodeURIComponent(part))).join("/");
  const query = Array.from(target.searchParams, ([name, value]) => [encode(name), encode(value)])
      .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
      .map(([name, value]) => name + "=" + value).join("&");
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map(name => name + ":" + String(signed[name]).trim().replace(/\s+/g, " ") + "\n").join("");
  const signedHeaders = names.join(";");
  const canonical = [method, uri, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, s3PayloadHash(canonical)].join("\n");
  const hmac = (key, value) => Crypto.createHmac("sha256", key).update(value).digest();
  const dateKey = hmac("AWS4" + credentials.secretAccessKey, date);
  const regionKey = hmac(dateKey, credentials.region);
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = hmac(signingKey, stringToSign).toString("hex");
  signed.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return signed;
}
