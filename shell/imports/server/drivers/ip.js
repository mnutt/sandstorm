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
import { Match, check } from "meteor/check";

import { PersistentImpl, fetchApiToken } from "/imports/server/persistent";
import { inMeteor } from "/imports/server/async-helpers";
import Net from "net";
import Tls from "tls";
import Dgram from "dgram";
import Capnp from "/imports/server/capnp";

const IpRpc = Capnp.importSystem("sandstorm/ip.capnp");
const BackendRpc = Capnp.importSystem("sandstorm/backend.capnp");

class ByteStreamConnection {
  constructor(connection) {
    this.connection = connection;
  }

  done() {
    this.connection.end();
  }

  write(data) {
    // TODO: try to apply some backpressure? Node docs say that write()
    // always succeeds and just buffers the data if needed, so we could
    // end up burning a bunch of memory if the sender is sending too
    // fast.
    this.connection.write(data);
  }

  // expectSize not implemented
  // expectSize(size) { }
}

class IpInterfaceImpl extends PersistentImpl {
  constructor(db, saveTemplate) {
    super(db, saveTemplate);
    this.db = db;
    this.grainId = resolveSaveTemplateGrainId(db, saveTemplate);
  }

  listenTcp(portNum, port) {
    return new Promise((resolve, reject) => {
      let resolved = false;
      const server = Net.createServer((connection) => {
        const wrappedConnection = new ByteStreamConnection(connection);
        const upstream = port.connect(wrappedConnection).upstream;

        connection.on("data", (data) => {
          upstream.write(data);
        });

        connection.on("close", (hadError) => {
          upstream.done();
        });

        connection.on("error", (err) => {
          if (resolved) {
            connection.write = errorWrite;
          } else {
            // upstream hasn't been resolved yet, so it's safe to reject
            reject(err);
          }
        });
      });

      server.listen(portNum, () => {
        resolved = true;
        resolve({ handle: server }); // server has a close method which is all we want from a handle
      });

      server.on("error", (err) => {
        if (!resolved) {
          reject(err);
        }
      });
    });
  }

  listenUdp(portNum, port) {
    return new Promise((resolve, reject) => {
      const portMap = {};
      let resolved = false;
      const server = Dgram.createSocket("udp4"); // TODO(someday): handle ipv6 sockets too
      server.bind(portNum);

      server.on("listening", () => {
        // Although UDP is connectionless, we don't resolve until here so that we can handle bind
        // errors such as invalid host
        resolved = true;
        resolve({ handle: server }); // server has a close method which is all we want from a handle
      });

      server.on("error", (err) => {
        // TODO(someday): do something about errors after the promise is resolved
        if (!resolved) {
          reject(err);
        } else {
          console.error("error in listenUdp: " + err);
        }
      });

      const returnMap = {};
      server.on("message", (msg, rinfo) => {
        const address = rinfo.address + "]:" + rinfo.port;
        let returnPort = returnMap[address];

        if (!returnPort) {
          returnMap[address] = returnPort = new BoundUdpPortImpl(server, rinfo.address, rinfo.port);
        }

        port.send(msg, returnPort);
      });
    });
  }

  bindRawUdp(portNum) {
    if (this.grainId) {
      return getOrCreateManagedRawUdpSocket(this.db, this.grainId, portNum).then((socket) => {
        return { socket };
      });
    }

    return bindRawUdpSocket({
      type: "udp4",
      bindPort: portNum,
    }).then((socket) => {
      return { socket };
    });
  }
}

// TODO(cleanup): Meteor.startup() needed because 00-startup.js runs *after* code in subdirectories
//   (ugh).
Meteor.startup(() => {
  if (typeof globalFrontendRefRegistry === "undefined") return;

  globalFrontendRefRegistry.register({
    frontendRefField: "ipInterface",
    typeId: IpRpc.IpInterface.typeId,

    restore(db, saveTemplate) {
      return new Capnp.Capability(new IpInterfaceImpl(db, saveTemplate),
                                  IpRpc.PersistentIpInterface);
    },

    validate(db, session, value) {
      check(value, true);

      if (!session.userId) {
        throw new Meteor.Error(403, "Not logged in.");
      }

      return {
        descriptor: { tags: [{ id: IpRpc.IpInterface.typeId }] },
        requirements: [{ userIsAdmin: session.userId }],
        frontendRef: value,
      };
    },

    query(db, userId, value) {
      if (userId && Meteor.users.findOne(userId).isAdmin) {
        return [
          {
            _id: "frontendref-ipinterface",
            frontendRef: { ipInterface: true },
            cardTemplate: "ipInterfacePowerboxCard",
          },
        ];
      } else {
        return [];
      }
    },
  });
});

Meteor.startup(() => {
  if (typeof globalDb === "undefined" || !globalDb.collections || !globalDb.collections.grains) {
    return;
  }

  const grains = globalDb.collections.grains.find({
    rawUdpPublicPort: { $exists: true },
  }, {
    fields: { rawUdpPublicPort: 1 },
  }).fetch();

  grains.forEach((grain) => {
    const port = getManagedRawUdpPortField(grain);
    if (!isManagedRawUdpPort(port)) return;

    ensureManagedRawUdpSocketForPort(globalDb, grain._id, port, true).catch((err) => {
      console.error("failed to restore managed raw udp socket for grain " + grain._id +
          " on port " + port + ":", err);
    });
  });
});

class BoundUdpPortImpl {
  constructor(server, address, port) {
    this.server = server;
    this.address = address;
    this.port = port;
  }

  send(message, returnPort) {
    // TODO(someday): this whole class is a hack to deal with the fact that we can't compare
    // capabilities or build a map with them. What we should be doing is mapping all ports to
    // their raw physical address/port, and using that here
    this.server.send(message, 0, message.length, this.port, this.address);
  }
}

const bits16 = (1n << 16n) - 1n;
const bits32 = (1n << 32n) - 1n;

const Ecn = IpRpc.Ecn || {
  notEct: "notEct",
  ect0: "ect0",
  ect1: "ect1",
  ce: "ce",
};

const intToIpv4 = (num) => {
  const part1 = num & 255;
  const part2 = ((num >> 8) & 255);
  const part3 = ((num >> 16) & 255);
  const part4 = ((num >> 24) & 255);

  return part4 + "." + part3 + "." + part2 + "." + part1;
};

const addressToString = (address) => {
  const ipv6num = (BigInt(address.upper64) << 64n) + BigInt(address.lower64);

  if ((ipv6num >> 32n) === bits16) {
    // this is an ipv4 address, we should return it as such
    const ipv4num = Number(ipv6num & bits32);
    return intToIpv4(ipv4num);
  }

  const hex = ipv6num.toString(16);
  let numColons = 0;
  let out = "";

  for (let i = 0; i < hex.length; ++i) {
    // start with lower bits of address and build the output in reverse
    // this ensures that we can place a colon every 4 characters
    out += hex[hex.length - 1 - i];
    if ((i + 1) % 4 === 0) {
      out += ":";
      ++numColons;
    }
  }

  // Double colon represents all bits being 0
  if (numColons < 7) {
    out += "::";
  }

  return out.split("").reverse().join("");
};

const addressType = (address) => {
  let type = "udp4";

  // Check if it's an ipv6 address
  // TODO(someday): make this less hacky and change address to explicitly pass this information
  if (address.indexOf(":") != -1) {
    type = "udp6";
  }

  return type;
};

const ipv4StringToInt = (address) => {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error("only IPv4 addresses are currently supported");
  }

  return (((parts[0] << 24) >>> 0) |
          (parts[1] << 16) |
          (parts[2] << 8) |
          parts[3]) >>> 0;
};

const stringToIpAddress = (address) => {
  if (address.indexOf(":") !== -1) {
    throw new Error("IPv6 raw UDP is not yet supported");
  }

  return {
    upper64: 0,
    lower64: 0x0000ffff00000000 + ipv4StringToInt(address),
  };
};

const socketAddressToEndpoint = (address, port) => {
  return {
    address: stringToIpAddress(address),
    port,
  };
};

const endpointToSocketAddress = (endpoint) => {
  return {
    address: addressToString(endpoint.address),
    port: endpoint.port,
  };
};

const endpointToDgramType = (endpoint) => {
  return addressType(addressToString(endpoint.address));
};

const endpointsEqual = (left, right) => {
  return left.port === right.port &&
      left.address.upper64 === right.address.upper64 &&
      left.address.lower64 === right.address.lower64;
};

const nodeAddressToEndpoint = (info) => {
  return socketAddressToEndpoint(info.address, info.port);
};

const normalizeLocalSocketInfo = (info) => {
  if (!info || !info.address) return info;

  if (info.address === "0.0.0.0") {
    return Object.assign({}, info, { address: "127.0.0.1" });
  }

  if (info.address === "::") {
    return Object.assign({}, info, { address: "::1" });
  }

  return info;
};

const normalizeEcn = (ecn) => {
  if (ecn === Ecn.ect0 || ecn === "ect0") return Ecn.ect0;
  if (ecn === Ecn.ect1 || ecn === "ect1") return Ecn.ect1;
  if (ecn === Ecn.ce || ecn === "ce") return Ecn.ce;
  return Ecn.notEct;
};

const MANAGED_RAW_UDP_MIN_PORT = 40000;
const MANAGED_RAW_UDP_MAX_PORT = 59999;
const managedRawUdpSockets = new Map();
const managedRawUdpWakePromises = new Map();
let managedRawUdpWakeListenerCap = null;

const getManagedRawUdpPortField = (grain) => {
  return grain && grain.rawUdpPublicPort;
};

const resolveSaveTemplateGrainId = (db, saveTemplate) => {
  if (!saveTemplate) return null;
  if (saveTemplate.grainId) return saveTemplate.grainId;

  if (saveTemplate.parentTokenKey) {
    const parentToken = fetchApiToken(db, saveTemplate.parentTokenKey);
    if (parentToken && parentToken.grainId) {
      return parentToken.grainId;
    }
  }

  const requirements = saveTemplate.requirements || [];
  for (let i = 0; i < requirements.length; i++) {
    const requirement = requirements[i];
    if (requirement && requirement.permissionsHeld && requirement.permissionsHeld.grainId) {
      return requirement.permissionsHeld.grainId;
    }
  }

  return null;
};

const clearManagedRawUdpPort = (db, grainId, port) => {
  db.collections.grains.update({
    _id: grainId,
    rawUdpPublicPort: port,
  }, {
    $unset: { rawUdpPublicPort: "" },
  });
};

const isManagedRawUdpPort = (port) => {
  return Number.isInteger(port) &&
      port >= MANAGED_RAW_UDP_MIN_PORT &&
      port <= MANAGED_RAW_UDP_MAX_PORT;
};

const allocateManagedRawUdpPort = (db, grainId, preferredPort) => {
  const grains = db.collections.grains;
  const existing = grains.findOne(grainId, { fields: { rawUdpPublicPort: 1 } });
  if (!existing) {
    throw new Meteor.Error(404, "Grain Not Found", "Grain ID: " + grainId);
  }

  const existingPort = getManagedRawUdpPortField(existing);
  if (existingPort) return existingPort;

  if (isManagedRawUdpPort(preferredPort)) {
    const taken = grains.findOne({
      _id: { $ne: grainId },
      rawUdpPublicPort: preferredPort,
    }, {
      fields: { _id: 1 },
    });

    if (!taken) {
      const updated = grains.update({
        _id: grainId,
        rawUdpPublicPort: { $exists: false },
      }, {
        $set: { rawUdpPublicPort: preferredPort },
      });

      if (updated > 0) return preferredPort;

      const refreshed = grains.findOne(grainId, { fields: { rawUdpPublicPort: 1 } });
      if (refreshed && refreshed.rawUdpPublicPort) {
        return refreshed.rawUdpPublicPort;
      }
    }
  }

  const rangeSize = MANAGED_RAW_UDP_MAX_PORT - MANAGED_RAW_UDP_MIN_PORT + 1;
  const start = Math.floor(Math.random() * rangeSize);
  for (let i = 0; i < rangeSize; i++) {
    const port = MANAGED_RAW_UDP_MIN_PORT + ((start + i) % rangeSize);
    const taken = grains.findOne({
      _id: { $ne: grainId },
      rawUdpPublicPort: port,
    }, {
      fields: { _id: 1 },
    });
    if (taken) continue;

    const updated = grains.update({
      _id: grainId,
      rawUdpPublicPort: { $exists: false },
    }, {
      $set: { rawUdpPublicPort: port },
    });

    if (updated > 0) return port;

    const refreshed = grains.findOne(grainId, { fields: { rawUdpPublicPort: 1 } });
    if (refreshed && refreshed.rawUdpPublicPort) {
      return refreshed.rawUdpPublicPort;
    }
  }

  throw new Error("no available managed raw udp ports");
};

const wakeManagedRawUdpGrain = (grainId) => {
  if (managedRawUdpWakePromises.has(grainId)) {
    return managedRawUdpWakePromises.get(grainId);
  }

  const backend = typeof globalBackend === "undefined" ? null : globalBackend;
  if (!backend) return Promise.resolve();

  const wakePromise = inMeteor(() => {
    return backend.useGrain(grainId, (supervisor) => {
      const uiView = supervisor.getMainView().view;
      return uiView.getViewInfo().then(() => undefined);
    });
  }).catch((err) => {
    console.error("managed raw udp wake failed for grain " + grainId + ":", err);
  }).then(() => {
    managedRawUdpWakePromises.delete(grainId);
  });

  managedRawUdpWakePromises.set(grainId, wakePromise);
  return wakePromise;
};

class ManagedRawUdpWakeListenerImpl {
  wake(grainId) {
    return wakeManagedRawUdpGrain(grainId).then(() => undefined);
  }
}

const getManagedRawUdpWakeListenerCap = () => {
  if (!managedRawUdpWakeListenerCap) {
    managedRawUdpWakeListenerCap = new Capnp.Capability(
        new ManagedRawUdpWakeListenerImpl(),
        BackendRpc.ManagedRawUdpWakeListener);
  }

  return managedRawUdpWakeListenerCap;
};

const isBackendManagedRawUdpUnavailable = (err) => {
  return err && (err.kjType === "unimplemented" ||
      /managed rawudp ports are not yet implemented|unimplemented/i.test(err.message || ""));
};

class BackendManagedRawUdpSocketImpl {
  constructor(portCap, managedGrainId) {
    this.portCap = portCap;
    this.managedGrainId = managedGrainId;
  }

  send(packet) {
    return this.portCap.send(packet).then(() => undefined);
  }

  setReceiver(receiver) {
    return this.portCap.setReceiver(receiver);
  }

  getLocalEndpoint() {
    return this.portCap.getLocalEndpoint().then((result) => {
      return result;
    });
  }

  getCapabilities() {
    return {
      capabilities: {
        mayFragment: true,
        maxReceiveSegments: 1,
        maxTransmitSegments: 1,
      },
    };
  }

  close() {
    this.portCap.clearReceiver().catch((err) => {
      console.error("failed to clear backend-managed raw udp receiver:", err);
    });
  }
}

class RawUdpSocketImpl {
  constructor(socket, options = {}) {
    this.socket = socket;
    this.receiver = null;
    this.closed = false;
    this.fixedRemoteEndpoint = options.fixedRemoteEndpoint || null;
    this.managedGrainId = options.managedGrainId || null;

    this.socket.on("message", (msg, rinfo) => {
      if (!this.receiver) {
        this.maybeWakeForIncoming();
        return;
      }

      if (this.fixedRemoteEndpoint && !endpointsEqual(nodeAddressToEndpoint(rinfo),
          this.fixedRemoteEndpoint)) {
        return;
      }

      let localInfo;
      try {
        localInfo = normalizeLocalSocketInfo(this.socket.address());
      } catch (err) {
        console.error("failed to read raw udp local address:", err);
        return;
      }

      const packet = {
        payload: msg,
        src: nodeAddressToEndpoint(rinfo),
        dst: nodeAddressToEndpoint(localInfo),
        ecn: Ecn.notEct,
        truncated: false,
      };

      Promise.resolve(this.receiver.receive(packet)).catch((err) => {
        if (this.managedGrainId && err &&
            (err.kjType === "disconnected" || err.kjType === "failed" ||
             /disconnected|not running|canceled|cancelled/i.test(String(err.message || err)))) {
          this.receiver = null;
          console.error("managed raw udp receiver became stale for grain " +
              this.managedGrainId + ":", err && err.message ? err.message : err);
          this.maybeWakeForIncoming();
        }

        console.error("raw udp receiver callback failed:", err);
      });
    });

    this.socket.on("error", (err) => {
      if (!this.closed) {
        console.error("raw udp socket error:", err);
      }
    });
  }

  maybeWakeForIncoming() {
    if (!this.managedGrainId) return;
    void wakeManagedRawUdpGrain(this.managedGrainId);
  }

  send(packet) {
    if (this.closed) {
      throw new Error("raw udp socket is closed");
    }

    if (!packet || !packet.dst) {
      throw new Error("raw udp packet is missing destination");
    }

    const dst = endpointToSocketAddress(packet.dst);
    if (dst.address.indexOf(":") !== -1) {
      throw new Error("IPv6 raw udp send is not yet supported");
    }

    if (this.fixedRemoteEndpoint && !endpointsEqual(packet.dst, this.fixedRemoteEndpoint)) {
      throw new Error("raw udp packet destination does not match connected remote peer");
    }

    const payload = packet.payload || Buffer.alloc(0);
    return new Promise((resolve, reject) => {
      this.socket.send(payload, 0, payload.length, dst.port, dst.address, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve(undefined);
        }
      });
    });
  }

  setReceiver(receiver) {
    this.receiver = receiver;
  }

  getLocalEndpoint() {
    if (this.closed) {
      throw new Error("raw udp socket is closed");
    }

    const info = normalizeLocalSocketInfo(this.socket.address());
    return { endpoint: nodeAddressToEndpoint(info) };
  }

  getCapabilities() {
    return {
      capabilities: {
        mayFragment: true,
        maxReceiveSegments: 1,
        maxTransmitSegments: 1,
      },
    };
  }

  close() {
    if (this.closed) return;
    if (this.managedGrainId) {
      this.receiver = null;
      return;
    }

    this.closed = true;
    this.receiver = null;
    this.socket.close();
  }
}

const bindRawUdpSocket = ({ type, bindPort, fixedRemoteEndpoint }) => {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const socket = Dgram.createSocket(type);

    socket.on("listening", () => {
      resolved = true;
      resolve(new RawUdpSocketImpl(socket, { fixedRemoteEndpoint }));
    });

    socket.on("error", (err) => {
      if (!resolved) {
        reject(err);
      }
    });

    socket.bind(bindPort);
  });
};

const bindManagedRawUdpSocket = (grainId, bindPort) => {
  return bindRawUdpSocket({
    type: "udp4",
    bindPort,
  }).then((socket) => {
    socket.managedGrainId = grainId;
    return socket;
  });
};

const ensureLocalManagedRawUdpSocketForPort = (db, grainId, bindPort, allowReallocate = true) => {
  const existing = managedRawUdpSockets.get(grainId);
  if (existing) return Promise.resolve(existing);

  return bindManagedRawUdpSocket(grainId, bindPort).catch((err) => {
    if (allowReallocate && err && err.code === "EADDRINUSE") {
      clearManagedRawUdpPort(db, grainId, bindPort);
      const reallocatedPort = allocateManagedRawUdpPort(db, grainId);
      return ensureLocalManagedRawUdpSocketForPort(db, grainId, reallocatedPort, false);
    }

    throw err;
  }).then((socket) => {
    managedRawUdpSockets.set(grainId, socket);
    return socket;
  });
};

const ensureBackendManagedRawUdpSocketForPort = (grainId, bindPort) => {
  const existing = managedRawUdpSockets.get(grainId);
  if (existing) return Promise.resolve(existing);

  const backend = typeof globalBackend === "undefined" ? null : globalBackend;
  if (!backend || typeof backend.ensureManagedRawUdpPort !== "function") {
    return Promise.reject(new Meteor.Error("unimplemented",
        "managed RawUdp ports are not yet implemented in the backend"));
  }

  return Promise.resolve(backend.ensureManagedRawUdpPort(
      grainId, bindPort, getManagedRawUdpWakeListenerCap())).then((result) => {
    const socket = new BackendManagedRawUdpSocketImpl(result.port, grainId);
    managedRawUdpSockets.set(grainId, socket);
    return socket;
  });
};

const ensureManagedRawUdpSocketForPort = (db, grainId, bindPort, allowReallocate = true) => {
  return ensureBackendManagedRawUdpSocketForPort(grainId, bindPort).catch((err) => {
    if (isBackendManagedRawUdpUnavailable(err)) {
      return ensureLocalManagedRawUdpSocketForPort(db, grainId, bindPort, allowReallocate);
    }

    throw err;
  });
};

const getOrCreateManagedRawUdpSocket = (db, grainId, requestedPort) => {
  const existing = managedRawUdpSockets.get(grainId);
  if (existing) return Promise.resolve(existing);

  const allocatedPort = allocateManagedRawUdpPort(db, grainId, requestedPort);
  return ensureManagedRawUdpSocketForPort(db, grainId, allocatedPort, true);
};

class IpNetworkImpl extends PersistentImpl {
  constructor(db, saveTemplate, tls) {
    super(db, saveTemplate);
    this.tls = tls;
  }

  getRemoteHost(address) {
    // Note that TLS typically authenticates hostnames, not raw IP addresses. So if `this.tls`
    // is true, then the returned `IpRemoteHost` will likely refuse to make any connections.
    // However, we keep that code path active because there is in principle no reason why it
    // should always fail, and we wish to allow for a possible future in which we let users
    // specify custom certificate authorities, in which case it might be more likely for TLS
    // to be expected to authenticate raw IP addresses.

    return { host: new IpRemoteHostImpl(addressToString(address), this.tls) };
  }

  getRemoteHostByName(address) {
    return { host: new IpRemoteHostImpl(address, this.tls) };
  }
}

// TODO(cleanup): Meteor.startup() needed because 00-startup.js runs *after* code in subdirectories
//   (ugh).
Meteor.startup(() => {
  if (typeof globalFrontendRefRegistry === "undefined") return;

  globalFrontendRefRegistry.register({
    frontendRefField: "ipNetwork",
    typeId: IpRpc.IpNetwork.typeId,

    restore(db, saveTemplate, value) {
      return new Capnp.Capability(
        new IpNetworkImpl(db, saveTemplate, "tls" in value.encryption),
        IpRpc.PersistentIpNetwork);
    },

    validate(db, session, value) {
      check(value, { encryption: Match.OneOf({ none: null }, { tls: null }) });

      if (!session.userId) {
        throw new Meteor.Error(403, "Not logged in.");
      }

      return {
        descriptor: {
          tags: [
            {
              id: IpRpc.IpNetwork.typeId,
              value: Capnp.serialize(
                IpRpc.IpNetwork.PowerboxTag,
                value),
            },
          ],
        },
        requirements: [{ userIsAdmin: session.userId }],
        frontendRef: value,
      };
    },

    query(db, userId, value) {
      let encryption = { none: null };
      if (value) {
        encryption = Capnp.parse(IpRpc.IpNetwork.PowerboxTag, value).encryption || encryption;
      }

      if (userId && Meteor.users.findOne(userId).isAdmin) {
        return [
          {
            _id: "frontendref-ipnetwork",
            frontendRef: { ipNetwork: { encryption } },
            cardTemplate: "ipNetworkPowerboxCard",
          },
        ];
      } else {
        return [];
      }
    },
  });
});

class IpRemoteHostImpl {
  constructor(address, tls) {
    this.address = address;
    this.tls = tls;
  }

  getTcpPort(portNum) {
    return { port: new TcpPortImpl(this.address, portNum, this.tls) };
  }

  getUdpPort(portNum) {
    if (this.tls) {
      const error = new Error("Datagram Transport Layer Security is not yet supported");
      error.kjType = "unimplemented";
      throw error;
    }

    return { port: new UdpPortImpl(this.address, portNum) };
  }

  connectRawUdp(portNum) {
    if (this.tls) {
      const error = new Error("Datagram Transport Layer Security is not yet supported");
      error.kjType = "unimplemented";
      throw error;
    }

    const endpoint = socketAddressToEndpoint(this.address, portNum);
    const type = endpointToDgramType(endpoint);
    return bindRawUdpSocket({
      type,
      bindPort: 0,
      fixedRemoteEndpoint: endpoint,
    }).then((socket) => {
      return { socket };
    });
  }
}

class TcpPortImpl {
  constructor(address, portNum, tls) {
    this.address = address;
    this.port = portNum;
    this.tls = tls;
  }

  connect(downstream) {
    const _this = this;
    let resolved = false;
    let connectMethod = Net.connect;
    if (this.tls) {
      connectMethod = Tls.connect;
    }

    return new Promise((resolve, reject) => {
      const client = connectMethod({ host: _this.address, port: _this.port }, () => {
        resolved = true;
        resolve({ upstream: new ByteStreamConnection(client) });
      });

      client.on("data", (data) => {
        downstream.write(data);
      });

      client.on("close", (hadError) => {
        downstream.done();
      });

      client.on("error", (err) => {
        if (resolved) {
          client.write = errorWrite;
        } else {
          // upstream hasn't been resolved yet, so it's safe to reject
          reject(err);
        }
      });
    });
  }
}

const errorWrite = (data) => {
  throw new Error("error occurred in connection");
};

class UdpPortImpl {
  constructor(address, portNum) {
    this.address = address;
    this.port = portNum;

    const type = addressType(address);
    this.socket = Dgram.createSocket(type);

    // TODO(someday): close socket after a certain time of inactivity?
    // This may be pointless since grains are killed frequently when not in use anyways

    // Temporary hack. We only expect clients to pass in a single return port, so we'll store it
    // and only send replies here.
    // This will be changed to be correct when equality comparisons are added to capabilities.
    this.returnPort = null;

    const _this = this;
    this.socket.on("message", (msg, rinfo) => {
      if (_this.returnPort) {
        _this.returnPort.send(msg, _this);
      }
    });
  }

  send(message, returnPort) {
    this.returnPort = returnPort;
    this.socket.send(message, 0, message.length, this.port, this.address);

    // TODO(someday): use callback to catch errors and do something with them
  }
}

export {
  MANAGED_RAW_UDP_MAX_PORT,
  MANAGED_RAW_UDP_MIN_PORT,
  allocateManagedRawUdpPort,
  Ecn,
  IpInterfaceImpl,
  IpRemoteHostImpl,
  RawUdpSocketImpl,
  bindRawUdpSocket,
  getOrCreateManagedRawUdpSocket,
  managedRawUdpSockets,
  normalizeLocalSocketInfo,
  socketAddressToEndpoint,
  wakeManagedRawUdpGrain,
};
