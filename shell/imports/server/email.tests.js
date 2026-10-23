import Nodemailer from "nodemailer";
import { SMTPServer } from "smtp-server";
import { send as sendEmail } from "/imports/server/email";

describe("SMTP delivery", function () {
  this.timeout(15000);
  it("checks rejected inputs and successful controls", async function () {
  for (const useTls of [false, true]) {
    let deliveries = 0;
    let transport;
    const originalCreateTransport = Nodemailer.createTransport;
    const server = new SMTPServer({
      authOptional: true,
      disabledCommands: useTls ? ["AUTH"] : ["AUTH", "STARTTLS"],
      onData(stream, session, callback) {
        stream.resume();
        stream.on("end", () => { deliveries++; callback(); });
      },
    });
    // A client rejecting the fixture certificate can close during the handshake.
    server.on("error", () => {});
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      Nodemailer.createTransport = function (...args) {
        transport = originalCreateTransport.apply(this, args);
        return transport;
      };
      let error;
      try {
        await sendEmail({
          from: "sender@example.com", to: "recipient@example.com", subject: "Delivery test",
          text: "Test message",
          smtpConfig: { hostname: "127.0.0.1", port: server.server.address().port },
        });
      } catch (err) { error = err; }
      if (useTls) {
        if (!error || !/certificate|self.signed/i.test(error.message) || deliveries !== 0) {
          throw new Error("SMTP accepted an untrusted fixture certificate: " + error);
        }
      } else if (error || deliveries !== 1) {
        throw new Error("Plain SMTP control did not deliver: " + error);
      }
    } finally {
      Nodemailer.createTransport = originalCreateTransport;
      if (transport) transport.close();
      await new Promise(resolve => server.close(resolve));
    }
  }
  return true;
  });
});
