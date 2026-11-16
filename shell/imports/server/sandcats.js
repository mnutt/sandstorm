// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Meteor } from "meteor/meteor";
import { Random } from "meteor/random";

import querystring from "querystring";
import https from "https";
import fs from "fs";
import dgram from "dgram";
import Url from "url";
import SandhostConfig from "./sandcats-v2/config";
import SandhostUpdater from "./sandcats-v2/updater";

import { SANDSTORM_ALTHOME } from "/imports/server/constants";

const SANDCATS_HOSTNAME = (Meteor.settings && Meteor.settings.public &&
                           Meteor.settings.public.sandcatsHostname);
const SANDCATS_VARDIR = (SANDSTORM_ALTHOME || "") + "/var/sandcats";
const SANDCATS_BACKEND = Meteor.settings.public?.sandcatsBackend || "legacy";

const Sandcats = {};

// Figure out what IP address to send Sandcats requests from. For machines with multiple IPs, it
// is important to use the IP to which we're binding. However, some people set BIND_IP to 127.0.0.1
// and put sniproxy in front of Sandstorm. In those cases, it won't work to send from BIND_IP;
// we'll have to let the system choose.
const BIND_IP = process.env.BIND_IP && process.env.BIND_IP.startsWith("127.")
    ? null : process.env.BIND_IP;

const ROOT_URL = Url.parse(process.env.ROOT_URL);
const HOSTNAME = ROOT_URL.hostname;
let SANDCATS_NAME; // Look at `startup` below to see where this is set

const updateSandcatsIp = () => {
  const responseCallback = (res) => {
    if (res.statusCode === 200) {
      console.log("Successfully updated sandcats IP");
    } else {
      console.error("Failed to update sandcats IP:", res.headers);
    }
  };

  const errorCallback = (err) => {
    console.error("Couldn't send update sandcats hostname", err);
  };

  performSandcatsRequest("/update", SANDCATS_HOSTNAME, { rawHostname: SANDCATS_NAME },
                         errorCallback, responseCallback);
};

const pingUdp = () => {
  const socket = dgram.createSocket("udp4");
  const secret = Random.secret(16);

  const message = new Buffer(SANDCATS_NAME + " " + secret);
  socket.on("message", (buf) => {
    if (buf.toString() === secret) {
      updateSandcatsIp();
    } else {
      console.error("Received unexpected response in UDP sandcats ping:", buf.toString());
    }
  });

  socket.on("error", (err) => {
    throw err;
  });

  const callback = () => {
    socket.send(message, 0, message.length, 8080, SANDCATS_HOSTNAME, (err) => {
      if (err) {
        console.error("Couldn't send UDP sandcats ping", err);
      }
    });

    setTimeout(() => {
      socket.close();
    }, 10 * 1000);
  };

  if (BIND_IP) {
    socket.bind({ address: BIND_IP }, callback);
  } else {
    callback();
  }
};

export function getSandcatsAcmeOptions() {
  if (SANDCATS_BACKEND === "sandhost") {
    return {
      hostname: getSandcatsName(),
      baseDomain: SANDCATS_HOSTNAME,
      key: fs.readFileSync(SANDCATS_VARDIR + "/id_rsa"),
      bindIp: SandhostConfig.localAddress(process.env.BIND_IP),
      ...SandhostConfig.readWebkey(SANDCATS_VARDIR + "/api-webkey"),
    };
  }
  // Get options for acme-dns-01-sandcats challenge module.
  return {
    hostname: SANDCATS_NAME,
    key: fs.readFileSync(SANDCATS_VARDIR + "/id_rsa"),
    cert: fs.readFileSync(SANDCATS_VARDIR + "/id_rsa.pub"),
    bindIp: BIND_IP
  };
}

const performSandcatsRequest = (path, hostname, postData, errorCallback, responseCallback) => {
  const options = {
    hostname: hostname,
    path: path,
    method: "POST",
    agent: false,
    key: fs.readFileSync(SANDCATS_VARDIR + "/id_rsa"),
    cert: fs.readFileSync(SANDCATS_VARDIR + "/id_rsa.pub"),
    headers: {
      "X-Sand": "cats",
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };

  if (BIND_IP) {
    options.localAddress = BIND_IP;
  }

  if (postData.certificateSigningRequest) {
    console.log("Submitting certificate request for host",
                postData.rawHostname, "where the request has length",
                postData.certificateSigningRequest.length);
  }

  const newPostData = querystring.stringify(postData);
  if ((SANDCATS_HOSTNAME === "sandcats-dev.sandstorm.io") &&
      !process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
    console.log("You are using the Sandcats dev server but have full HTTPS " +
                "certificate checking enabled. Probably you will get an HTTPS " +
                "error. Proceeding anyway.");
  }

  const req = https.request(options, responseCallback);
  req.write(newPostData);
  req.end();

  if (errorCallback) {
    req.on("error", errorCallback);
  }

  return req;
};

Sandcats.initializeSandcats = () => {
  if (SANDCATS_BACKEND === "sandhost") {
    SANDCATS_NAME = getSandcatsName();
    if (!SANDCATS_NAME || !/^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/.test(SANDCATS_NAME)) {
      throw new Error("Sandcats HOSTNAME must be a single registered name under SANDCATS_BASE_DOMAIN");
    }
    const options = getSandcatsAcmeOptions();
    const updater = new SandhostUpdater.Updater({
      ...options,
      rawHostname: SANDCATS_NAME,
      privateKey: options.key,
      localAddress: options.bindIp,
      addressMode: process.env.SANDCATS_ADDRESS_MODE || "observed",
      ipAddress: process.env.SANDCATS_IP_ADDRESS || "",
    });
    SandhostUpdater.startUpdater(updater, {
      // Do not log request objects or provider-supplied error text: they can contain credentials.
      onError: () => console.error("Sandcats IP update failed; retrying with backoff."),
    });
    return;
  }
  const i = HOSTNAME.lastIndexOf(SANDCATS_HOSTNAME);
  if (i < 0) {
    console.error("SANDCATS_BASE_DOMAIN is configured but your HOSTNAME doesn't appear to contain it:",
                  SANDCATS_HOSTNAME, HOSTNAME);
  } else {
    const oneMinute = 60 * 1000;
    // All Sandcats installs need dyndns updating.
    SANDCATS_NAME = HOSTNAME.slice(0, i - 1);
    Meteor.setInterval(pingUdp, oneMinute);
  }
};

if (SANDCATS_HOSTNAME) {
  Meteor.startup(Sandcats.initializeSandcats);
}

export function getSandcatsName() {
  if (SANDCATS_HOSTNAME && HOSTNAME.endsWith("." + SANDCATS_HOSTNAME)) {
    return HOSTNAME.slice(0, -SANDCATS_HOSTNAME.length - 1);
  } else {
    return null;
  }
}

export function getSandcatsAcmeModule() {
  if (SANDCATS_BACKEND === "sandhost" && getSandcatsName()) return "sandhost";
  // Preserve legacy certificate selection, including installations without an explicit backend.
  if (SANDCATS_BACKEND === "legacy" && HOSTNAME.endsWith(".sandcats.io")) return "sandcats";
  return null;
}
