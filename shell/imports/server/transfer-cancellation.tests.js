import { assert } from "chai";
import { EventEmitter } from "events";
import { Downloader, setTransferDownloaderHooksForTests }
  from "/imports/server/transfers-server";

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

describe("Transfer cancellation", function () {
  it("handles request errors when canceled during address lookup", async function () {
    const started = deferred();
    const release = deferred();
    const errorEmitted = deferred();
    const request = new EventEmitter();
    let destroyed = false;
    let ended = false;
    let unhandledError;
    request.end = () => { ended = true; };
    request.destroy = () => {
      if (destroyed) return;
      destroyed = true;
      process.nextTick(() => {
        try {
          request.emit("error", new Error("socket hang up"));
        } catch (error) {
          // Capture an unhandled error so the regression fails without crashing the test server.
          unhandledError = error;
        } finally {
          errorEmitted.resolve();
        }
      });
    };

    let downloader;
    setTransferDownloaderHooksForTests({
      request: async () => {
        started.resolve();
        await release.promise;
        return request;
      },
    });
    try {
      downloader = new Downloader({
        source: "http://transfer-test.invalid", grainId: "canceled-grain",
        remoteFileToken: "test-token",
      });
      await started.promise;
      downloader.cancel();
      release.resolve();
      await downloader.promise;
      await errorEmitted.promise;

      assert.isTrue(destroyed);
      assert.isFalse(ended);
      assert.isUndefined(unhandledError);
      assert.isUndefined(downloader.error);
    } finally {
      release.resolve();
      if (downloader) {
        downloader.cancel();
        await downloader.promise;
      }
      setTransferDownloaderHooksForTests(null);
    }
  });
});
