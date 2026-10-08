// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm Development Group, Inc. and contributors
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

// Exercise the SMTP DATA handler with the real parser and Cap'n Proto serializer.
// Run after building the dev bundle:
//   build/dev/bundle/bin/node tests/mail-driver.test.js
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");
const vm = require("node:vm");
const { transformSync } = require("../shell/node_modules/@swc/core");
const { simpleParser } = require("../shell/node_modules/mailparser");
const Capnp = require(process.env.CAPNP_MODULE || "../build/dev/bundle/node_modules/capnp.js");
const EmailRpc = Capnp.importSystem("sandstorm/email.capnp");

const source = transformSync(fs.readFileSync(path.join(__dirname,
    "../shell/imports/server/drivers/mail.js"), "utf8"), {
  jsc: { target: "es2020", parser: { syntax: "ecmascript" } },
  module: { type: "commonjs" },
}).code;

function makeDriver() {
  let onData;
  const deliveries = [];
  const lookups = [];
  const warnings = [];
  const mocks = {
    "meteor/meteor": { Meteor: { settings: { replicaNumber: 1 }, startup: fn => fn() } },
    "meteor/check": {},
    "meteor/random": { Random: { id: () => "test-id" } },
    "meteor/accounts-base": {},
    "meteor/underscore": { _: { uniq: values => [...new Set(values)] } },
    "smtp-server": { SMTPServer: class {
      constructor(options) { onData = options.onData; }
      listen() {}
    } },
    mailparser: { simpleParser },
    "/imports/sandstorm-db/db": {},
    "/imports/db-deprecated": { globalDb: { collections: { grains: {
      findOne(query) {
        lookups.push(query.publicId);
        return query.publicId === "grain-public-id" ? { _id: "grain-id" } : null;
      },
    } } } },
    globalBackend: {
      async continueGrain(grainId) {
        assert.equal(grainId, "grain-id");
        return { supervisor: { getMainView: () => ({ view: {
          newSession: () => ({ session: { castAs: () => ({
            async send(message) {
              // Use the same schema conversion as EmailSendPort.send before recording delivery.
              deliveries.push(Capnp.parse(EmailRpc.EmailMessage,
                  Capnp.serialize(EmailRpc.EmailMessage, message)));
            },
          }) } }),
        } }) } };
      },
    },
    "/imports/server/persistent": { PersistentImpl: class {} },
    "/imports/server/email": {},
    "/imports/server/backend": { shouldRestartGrain: () => false },
    "/imports/server/async-helpers": { inMeteor: fn => Promise.resolve().then(fn) },
    "/imports/server/hack-session": { makeHackSessionContext: () => ({}) },
    "/imports/server/capnp": Capnp,
  };
  vm.runInNewContext(source, {
    exports: {},
    hackSendEmail: undefined,
    globalBackend: mocks.globalBackend,
    globalFrontendRefRegistry: { register() {} },
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name),
    Npm: { require: name => require("../shell/node_modules/" + name) },
    process: { env: { ROOT_URL: "https://sandstorm.example.org" } },
    console: { error: (...args) => warnings.push(args), warn() {} },
    Buffer,
  });
  return {
    deliveries, lookups, warnings,
    deliver(raw) {
      return new Promise((resolve, reject) => {
        onData(Readable.from([raw]), { envelope: {
          mailFrom: { address: "bounce@example.org" },
          rcptTo: [{ address: "grain-public-id@example.org" }],
        } }, (err, response) => err ? reject(err) : resolve(response));
      });
    },
  };
}

function message(headers) {
  return headers.concat([
    "Subject: Address group regression",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "", "Test message.",
  ]).join("\r\n");
}

test("deliver an empty To group using the envelope recipient", async () => {
  const driver = makeDriver();
  assert.equal(await driver.deliver(message([
    "From: Sender <sender@example.org>",
    "To: undisclosed-recipients:;",
  ])), "Message delivered");
  assert.deepEqual(driver.lookups, ["grain-public-id"]);
  assert.equal(driver.deliveries.length, 1);
  assert.deepEqual(driver.deliveries[0].to, []);
  assert.deepEqual(driver.deliveries[0].from, {
    address: "sender@example.org", name: "Sender",
  });
});

test("preserve group members and individual mailboxes across address headers", async () => {
  const driver = makeDriver();
  const addresses = "Empty:;, Solo <solo@example.org>, " +
      "Team: Alice <alice@example.org>, bob@example.org;";
  await driver.deliver(message([
    `From: ${addresses}`, `Reply-To: ${addresses}`,
    `To: ${addresses}`, `Cc: ${addresses}`, `Bcc: ${addresses}`,
  ]));
  const mail = driver.deliveries[0];
  const expected = [
    { address: "solo@example.org", name: "Solo" },
    { address: "alice@example.org", name: "Alice" },
    { address: "bob@example.org", name: "" },
  ];
  for (const field of ["to", "cc", "bcc"]) assert.deepEqual(mail[field], expected);
  assert.deepEqual(mail.from, expected[0]);
  assert.deepEqual(mail.replyTo, expected[0]);
  assert.equal(driver.warnings.length, 1);
});
