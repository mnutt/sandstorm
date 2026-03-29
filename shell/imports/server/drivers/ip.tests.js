/* eslint-env mocha */

import { EventEmitter } from "events";
import chai from "chai";

import {
  allocateManagedRawUdpPort,
  getOrCreateManagedRawUdpSocket,
  Ecn,
  MANAGED_RAW_UDP_MAX_PORT,
  MANAGED_RAW_UDP_MIN_PORT,
  RawUdpSocketImpl,
  IpInterfaceImpl,
  managedRawUdpSockets,
  normalizeLocalSocketInfo,
  socketAddressToEndpoint,
} from "/imports/server/drivers/ip";
import { hashSturdyRef } from "/imports/server/persistent";

class FakeDgramSocket extends EventEmitter {
  constructor(localAddress = { address: "127.0.0.1", port: 4000 }) {
    super();
    this.localAddress = localAddress;
    this.sent = [];
    this.closed = false;
  }

  address() {
    return this.localAddress;
  }

  send(message, offset, length, port, address, callback) {
    this.sent.push({
      message: Buffer.from(message).slice(offset, offset + length),
      port,
      address,
    });

    if (callback) callback(null);
  }

  close() {
    this.closed = true;
  }
}

class FakeGrainsCollection {
  constructor(docs) {
    this.docs = docs;
  }

  findOne(query) {
    if (typeof query === "string") {
      return this.docs.find((doc) => doc._id === query) || null;
    }

    return this.docs.find((doc) => {
      if (query._id) {
        if (typeof query._id === "string") {
          if (doc._id !== query._id) return false;
        } else if ("$ne" in query._id) {
          if (doc._id === query._id.$ne) return false;
        }
      }

      if ("rawUdpPublicPort" in query) {
        const portQuery = query.rawUdpPublicPort;
        if (portQuery && typeof portQuery === "object" && "$exists" in portQuery) {
          const exists = "rawUdpPublicPort" in doc;
          if (exists !== portQuery.$exists) return false;
        } else if (doc.rawUdpPublicPort !== portQuery) {
          return false;
        }
      }

      return true;
    }) || null;
  }

  update(query, modifier) {
    const doc = this.findOne(query);
    if (!doc) return 0;

    if (modifier.$set) {
      Object.assign(doc, modifier.$set);
    }

    if (modifier.$unset) {
      Object.keys(modifier.$unset).forEach((key) => {
        delete doc[key];
      });
    }

    return 1;
  }
}

class FakeApiTokensCollection {
  constructor(docs) {
    this.docs = docs;
  }

  findOne(query) {
    return this.docs.find((doc) => {
      return Object.keys(query).every((key) => doc[key] === query[key]);
    }) || null;
  }
}

class FakeBackendManagedPort {
  constructor(endpoint = socketAddressToEndpoint("127.0.0.1", 5200)) {
    this.endpoint = endpoint;
    this.sent = [];
    this.receiver = null;
    this.clearCount = 0;
  }

  send(packet) {
    this.sent.push(packet);
    return Promise.resolve();
  }

  setReceiver(receiver) {
    this.receiver = receiver;
    return Promise.resolve();
  }

  clearReceiver() {
    this.receiver = null;
    this.clearCount += 1;
    return Promise.resolve();
  }

  getLocalEndpoint() {
    return Promise.resolve({ endpoint: this.endpoint });
  }
}

describe("RawUdpSocketImpl", function () {
  afterEach(function () {
    managedRawUdpSockets.clear();
    delete global.globalBackend;
  });

  it("maps incoming packets into raw udp metadata", async function () {
    const socket = new FakeDgramSocket({ address: "127.0.0.1", port: 4100 });
    const rawSocket = new RawUdpSocketImpl(socket);
    const received = [];

    rawSocket.setReceiver({
      receive(packet) {
        received.push(packet);
      },
    });

    const payload = Buffer.from("hello");
    socket.emit("message", payload, { address: "127.0.0.2", port: 4200 });
    await new Promise((resolve) => setImmediate(resolve));

    chai.assert.lengthOf(received, 1);
    chai.assert.deepEqual(received[0].payload, payload);
    chai.assert.deepEqual(received[0].src, socketAddressToEndpoint("127.0.0.2", 4200));
    chai.assert.deepEqual(received[0].dst, socketAddressToEndpoint("127.0.0.1", 4100));
    chai.assert.strictEqual(received[0].ecn, Ecn.notEct);
    chai.assert.strictEqual(received[0].truncated, false);
  });

  it("sends packets to the requested destination", async function () {
    const socket = new FakeDgramSocket();
    const rawSocket = new RawUdpSocketImpl(socket);

    await rawSocket.send({
      payload: Buffer.from("ping"),
      dst: socketAddressToEndpoint("127.0.0.3", 4300),
    });

    chai.assert.lengthOf(socket.sent, 1);
    chai.assert.deepEqual(socket.sent[0], {
      message: Buffer.from("ping"),
      port: 4300,
      address: "127.0.0.3",
    });
  });

  it("ignores packets from the wrong peer on fixed-remote sockets", async function () {
    const socket = new FakeDgramSocket({ address: "127.0.0.1", port: 4400 });
    const fixedRemote = socketAddressToEndpoint("127.0.0.9", 4500);
    const rawSocket = new RawUdpSocketImpl(socket, { fixedRemoteEndpoint: fixedRemote });
    const received = [];

    rawSocket.setReceiver({
      receive(packet) {
        received.push(packet);
      },
    });

    socket.emit("message", Buffer.from("drop"), { address: "127.0.0.8", port: 4500 });
    socket.emit("message", Buffer.from("keep"), { address: "127.0.0.9", port: 4500 });
    await new Promise((resolve) => setImmediate(resolve));

    chai.assert.lengthOf(received, 1);
    chai.assert.deepEqual(received[0].payload, Buffer.from("keep"));

    let err;
    try {
      await rawSocket.send({
        payload: Buffer.from("bad"),
        dst: socketAddressToEndpoint("127.0.0.7", 4500),
      });
    } catch (caught) {
      err = caught;
    }

    chai.assert.instanceOf(err, Error);
    chai.assert.match(err.message, /does not match connected remote peer/);
  });

  it("reports local endpoint and capabilities", function () {
    const socket = new FakeDgramSocket({ address: "127.0.0.4", port: 4600 });
    const rawSocket = new RawUdpSocketImpl(socket);

    chai.assert.deepEqual(rawSocket.getLocalEndpoint(), {
      endpoint: socketAddressToEndpoint("127.0.0.4", 4600),
    });

    chai.assert.deepEqual(rawSocket.getCapabilities(), {
      capabilities: {
        mayFragment: true,
        maxReceiveSegments: 1,
        maxTransmitSegments: 1,
      },
    });
  });

  it("normalizes wildcard local endpoints to loopback for reporting", function () {
    chai.assert.deepEqual(
      normalizeLocalSocketInfo({ address: "0.0.0.0", port: 4700 }),
      { address: "127.0.0.1", port: 4700 },
    );
    chai.assert.deepEqual(
      normalizeLocalSocketInfo({ address: "::", port: 4701 }),
      { address: "::1", port: 4701 },
    );
  });

  it("uses normalized local endpoint metadata for wildcard-bound sockets", async function () {
    const socket = new FakeDgramSocket({ address: "0.0.0.0", port: 4800 });
    const rawSocket = new RawUdpSocketImpl(socket);
    const received = [];

    rawSocket.setReceiver({
      receive(packet) {
        received.push(packet);
      },
    });

    socket.emit("message", Buffer.from("hello"), { address: "127.0.0.9", port: 4900 });
    await new Promise((resolve) => setImmediate(resolve));

    chai.assert.deepEqual(rawSocket.getLocalEndpoint(), {
      endpoint: socketAddressToEndpoint("127.0.0.1", 4800),
    });
    chai.assert.lengthOf(received, 1);
    chai.assert.deepEqual(received[0].dst, socketAddressToEndpoint("127.0.0.1", 4800));
  });

  it("allocates one high managed raw udp port per grain", function () {
    const db = {
      collections: {
        grains: new FakeGrainsCollection([
          { _id: "grain-a" },
          { _id: "grain-b", rawUdpPublicPort: 45000 },
        ]),
      },
    };

    const port = allocateManagedRawUdpPort(db, "grain-a");
    chai.assert.isAtLeast(port, MANAGED_RAW_UDP_MIN_PORT);
    chai.assert.isAtMost(port, MANAGED_RAW_UDP_MAX_PORT);
    chai.assert.notStrictEqual(port, 45000);
    chai.assert.strictEqual(allocateManagedRawUdpPort(db, "grain-a"), port);
  });

  it("prefers a requested stable port for managed raw udp allocation", function () {
    const db = {
      collections: {
        grains: new FakeGrainsCollection([
          { _id: "grain-a" },
          { _id: "grain-b", rawUdpPublicPort: 45000 },
        ]),
      },
    };

    const port = allocateManagedRawUdpPort(db, "grain-a", 46789);
    chai.assert.strictEqual(port, 46789);
    chai.assert.strictEqual(allocateManagedRawUdpPort(db, "grain-a"), 46789);
  });

  it("derives the grain id for managed raw udp from the parent token chain", function () {
    const db = {
      collections: {
        apiTokens: new FakeApiTokensCollection([
          { _id: hashSturdyRef("parent-sturdy-ref"), grainId: "grain-from-parent" },
        ]),
      },
    };

    const ipInterface = new IpInterfaceImpl(db, {
      parentTokenKey: "parent-sturdy-ref",
    });

    chai.assert.strictEqual(ipInterface.grainId, "grain-from-parent");
  });

  it("wakes a managed grain when packets arrive without a receiver", async function () {
    const socket = new FakeDgramSocket({ address: "127.0.0.1", port: 5000 });
    const rawSocket = new RawUdpSocketImpl(socket, { managedGrainId: "grain-123" });
    const woken = [];
    global.globalBackend = {
      useGrain(grainId, cb) {
        woken.push(grainId);
        return cb({
          getMainView() {
            return {
              view: {
                getViewInfo() {
                  return Promise.resolve({});
                },
              },
            };
          },
        });
      },
    };

    socket.emit("message", Buffer.from("wake"), { address: "127.0.0.9", port: 5001 });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    chai.assert.deepEqual(woken, ["grain-123"]);
  });

  it("drops a disconnected managed receiver and wakes the grain", async function () {
    const socket = new FakeDgramSocket({ address: "127.0.0.1", port: 5050 });
    const rawSocket = new RawUdpSocketImpl(socket, { managedGrainId: "grain-456" });
    const woken = [];
    global.globalBackend = {
      useGrain(grainId, cb) {
        woken.push(grainId);
        return cb({
          getMainView() {
            return {
              view: {
                getViewInfo() {
                  return Promise.resolve({});
                },
              },
            };
          },
        });
      },
    };

    rawSocket.setReceiver({
      receive() {
        const err = new Error("remote exception: grain is not running");
        err.kjType = "disconnected";
        return Promise.reject(err);
      },
    });

    socket.emit("message", Buffer.from("wake"), { address: "127.0.0.9", port: 5051 });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    chai.assert.deepEqual(woken, ["grain-456"]);
    chai.assert.strictEqual(rawSocket.receiver, null);
  });

  it("reuses an already-restored managed socket for the grain", async function () {
    const rawSocket = new RawUdpSocketImpl(new FakeDgramSocket(), { managedGrainId: "grain-789" });
    managedRawUdpSockets.set("grain-789", rawSocket);

    const result = await getOrCreateManagedRawUdpSocket({
      collections: {
        grains: new FakeGrainsCollection([{ _id: "grain-789", rawUdpPublicPort: 47000 }]),
      },
    }, "grain-789", 47000);

    chai.assert.strictEqual(result, rawSocket);
  });

  it("prefers a backend-managed raw udp port when available", async function () {
    const backendPort = new FakeBackendManagedPort(
      socketAddressToEndpoint("127.0.0.1", 5300));
    global.globalBackend = {
      ensureManagedRawUdpPort(grainId, portNum, wakeListener) {
        chai.assert.strictEqual(grainId, "grain-backend");
        chai.assert.strictEqual(portNum, 5300);
        chai.assert.isOk(wakeListener);
        return Promise.resolve({ port: backendPort });
      },
    };

    const result = await getOrCreateManagedRawUdpSocket({
      collections: {
        grains: new FakeGrainsCollection([{ _id: "grain-backend", rawUdpPublicPort: 5300 }]),
      },
    }, "grain-backend", 5300);

    chai.assert.deepEqual(await result.getLocalEndpoint(), {
      endpoint: socketAddressToEndpoint("127.0.0.1", 5300),
    });

    const receiver = { receive() {} };
    await result.setReceiver(receiver);
    chai.assert.strictEqual(backendPort.receiver, receiver);

    await result.send({
      payload: Buffer.from("backend"),
      dst: socketAddressToEndpoint("127.0.0.1", 5301),
    });
    chai.assert.lengthOf(backendPort.sent, 1);

    result.close();
    await new Promise((resolve) => setImmediate(resolve));
    chai.assert.strictEqual(backendPort.clearCount, 1);
  });

  it("falls back to the local managed socket path when backend raw udp is unimplemented",
      async function () {
    global.globalBackend = {
      ensureManagedRawUdpPort() {
        const err = new Error("managed RawUdp ports are not yet implemented in the backend");
        err.kjType = "unimplemented";
        return Promise.reject(err);
      },
    };

    const result = await getOrCreateManagedRawUdpSocket({
      collections: {
        grains: new FakeGrainsCollection([{ _id: "grain-local", rawUdpPublicPort: 5400 }]),
      },
    }, "grain-local", 5400);

    chai.assert.instanceOf(result, RawUdpSocketImpl);
    chai.assert.strictEqual(result.managedGrainId, "grain-local");
  });

  it("retries a new backend-managed allocation on bind conflict before exposing the port",
      async function () {
    const requestedPort = 55000;
    const backendPort = new FakeBackendManagedPort(
      socketAddressToEndpoint("127.0.0.1", 5501));
    const attemptedPorts = [];
    const grainDoc = { _id: "grain-retry" };

    global.globalBackend = {
      ensureManagedRawUdpPort(grainId, portNum) {
        attemptedPorts.push(portNum);
        if (attemptedPorts.length === 1) {
          const err = new Error("address already in use");
          err.code = "EADDRINUSE";
          return Promise.reject(err);
        }

        return Promise.resolve({ port: backendPort });
      },

      dropManagedRawUdpPort() {
        return Promise.resolve();
      },
    };

    const result = await getOrCreateManagedRawUdpSocket({
      collections: {
        grains: new FakeGrainsCollection([grainDoc]),
      },
    }, "grain-retry", requestedPort);

    chai.assert.notInstanceOf(result, RawUdpSocketImpl);
    chai.assert.lengthOf(attemptedPorts, 2);
    chai.assert.strictEqual(attemptedPorts[0], requestedPort);
    chai.assert.notStrictEqual(attemptedPorts[1], requestedPort);
    chai.assert.strictEqual(grainDoc.rawUdpPublicPort, attemptedPorts[1]);
  });

  it("does not silently reallocate a persisted backend-managed port on bind conflict",
      async function () {
    const grainDoc = { _id: "grain-stable", rawUdpPublicPort: 5600 };
    global.globalBackend = {
      ensureManagedRawUdpPort() {
        const err = new Error("address already in use");
        err.code = "EADDRINUSE";
        return Promise.reject(err);
      },
    };

    let threw = false;
    try {
      await getOrCreateManagedRawUdpSocket({
        collections: {
          grains: new FakeGrainsCollection([grainDoc]),
        },
      }, "grain-stable", 5600);
    } catch (err) {
      threw = true;
      chai.assert.match(err.message, /address already in use/i);
    }

    chai.assert.isTrue(threw);
    chai.assert.strictEqual(grainDoc.rawUdpPublicPort, 5600);
  });

  it("keeps managed raw udp sockets bound when closed", function () {
    const socket = new FakeDgramSocket({ address: "127.0.0.1", port: 5100 });
    const rawSocket = new RawUdpSocketImpl(socket, { managedGrainId: "grain-123" });

    rawSocket.close();

    chai.assert.strictEqual(socket.closed, false);
    chai.assert.deepEqual(rawSocket.getLocalEndpoint(), {
      endpoint: socketAddressToEndpoint("127.0.0.1", 5100),
    });
  });
});
