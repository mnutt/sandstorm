/* eslint-env mocha */

import { EventEmitter } from "events";
import chai from "chai";

import {
  Ecn,
  RawUdpSocketImpl,
  socketAddressToEndpoint,
} from "/imports/server/drivers/ip";

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

describe("RawUdpSocketImpl", function () {
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
});
