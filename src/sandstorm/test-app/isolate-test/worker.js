import message from "message.txt";
import metadata from "metadata.json";
import {
  ClaimedCapability,
  RpcTarget,
  SavedCapability,
  sandstorm,
  powerbox as sandstormPowerbox,
} from "sandstorm:api";

function makeBytes(size) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < bytes.length; ++i) {
    bytes[i] = i & 0xff;
  }
  return bytes;
}

function checksum(bytes) {
  let sum = 0;
  for (const byte of bytes) {
    sum = (sum + byte) >>> 0;
  }
  return sum;
}

class CounterCapability extends RpcTarget {
  #value = 0;

  increment(amount = 1) {
    this.#value += Number(amount);
    return { value: this.#value };
  }

  get() {
    return { value: this.#value };
  }

  child() {
    return new CounterCapability();
  }

  async readOther(other) {
    return other.call("get");
  }

  fail(message = "counter failure") {
    throw new Error(String(message));
  }
}

export default {
  async fetch(request, env, ctx) {
    const objectCapabilityResponse = await sandstorm(request, env).serveObjectCapabilities();
    if (objectCapabilityResponse) return objectCapabilityResponse;

    const url = new URL(request.url);
    const headers = {};
    for (const [name, value] of request.headers) {
      if (name.startsWith("x-sandstorm-") || name === "host" ||
          name === "if-match" || name === "if-none-match") {
        headers[name] = value;
      }
    }

    if (url.pathname === "/echo") {
      const body = new Uint8Array(await request.arrayBuffer());
      return Response.json({
        ok: true,
        method: request.method,
        bodyBytes: body.length,
        checksum: checksum(body),
        contentType: request.headers.get("content-type"),
        customHeader: request.headers.get("x-isolate-test"),
      });
    }

    if (url.pathname === "/upload") {
      const body = new Uint8Array(await request.arrayBuffer());
      return Response.json({
        ok: true,
        method: request.method,
        bodyBytes: body.length,
        checksum: checksum(body),
        contentType: request.headers.get("content-type"),
      });
    }

    if (url.pathname === "/download") {
      const size = Math.min(Number(url.searchParams.get("bytes") || "0"), 1024 * 1024);
      return new Response(makeBytes(size), {
        headers: {
          "content-type": "application/octet-stream",
          "x-isolate-test-bytes": String(size),
          "x-isolate-test-checksum": String(checksum(makeBytes(size))),
        },
      });
    }

    if (url.pathname === "/headers") {
      return new Response("header response", {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "x-isolate-test": "present",
          "x-sandstorm-app-test-response": "present",
        },
      });
    }

    if (url.pathname === "/cache-revalidate") {
      return new Response("cache revalidate", {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "private, max-age=0",
        },
      });
    }

    if (url.pathname === "/cache-immutable") {
      return new Response("cache immutable", {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    }

    if (url.pathname === "/attachment") {
      return new Response("attachment body", {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": "attachment; filename=\"fixture.txt\"",
          "etag": "\"fixture-etag\"",
        },
      });
    }

    if (url.pathname === "/redirect") {
      return Response.redirect("https://example.invalid/next", 303);
    }

    if (url.pathname === "/empty") {
      return new Response(null, {
        status: 204,
        headers: { "etag": "W/\"empty-etag\"" },
      });
    }

    if (url.pathname === "/not-modified") {
      return new Response(null, {
        status: 304,
        headers: { "etag": "\"not-modified-etag\"" },
      });
    }

    if (url.pathname === "/error") {
      return new Response("fixture failure", {
        status: 418,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === "/offer-session") {
      const offered = sandstormPowerbox(request, env).offeredCapability();
      let fetched = null;
      let drop = null;
      if (offered) {
        const fetchedResponse = await offered.fetch("/capability-echo?source=offer-session");
        fetched = {
          status: fetchedResponse.status,
          body: await fetchedResponse.json(),
        };
        drop = await offered.drop();
      }
      return Response.json({
        ok: Boolean(offered),
        sessionType: request.headers.get("x-sandstorm-session-type"),
        offeredCapabilityId: request.headers.get("x-sandstorm-offered-capability-id"),
        offeredClass: offered instanceof ClaimedCapability,
        offered: offered ? JSON.parse(JSON.stringify(offered)) : null,
        fetched,
        drop,
      });
    }

    if (url.pathname === "/exported/capability-echo") {
      return Response.json({
        ok: true,
        source: "exported-web-session",
        pathname: url.pathname,
        search: url.search,
        sessionType: request.headers.get("x-sandstorm-session-type"),
      });
    }

    if (url.pathname === "/export-web-session") {
      const capability = await sandstorm(request, env).webSession({
        pathPrefix: "/exported",
      });
      return Response.json({
        ok: true,
        capabilityClass: capability instanceof ClaimedCapability,
        capability: JSON.parse(JSON.stringify(capability)),
      });
    }

    if (url.pathname === "/export-object-capability") {
      const capability = await sandstorm(request, env).capability(new CounterCapability());
      return Response.json({
        ok: true,
        capabilityClass: capability instanceof ClaimedCapability,
        capability: JSON.parse(JSON.stringify(capability)),
      });
    }

    if (url.pathname === "/object-capability-self-test") {
      const capability = await sandstorm(request, env).capability(new CounterCapability());
      const first = await capability.call("increment", 3);
      const second = await capability.call("increment", 4);
      const current = await capability.call("get");
      const child = await capability.call("child");
      const childFirst = await child.call("increment", 11);
      const readChild = await capability.call("readOther", child);
      let sessionActions = null;
      if (url.searchParams.get("sessionActions") === "true") {
        const offer = await capability.offer(request, {
          title: "WebSession offered capability",
          requiredPermissions: ["view"],
        });
        const fulfill = await capability.fulfillRequest(request, {
          title: "WebSession fulfilled capability",
          requiredPermissions: ["view"],
        });
        const tied = await capability.tieToUser(request, {
          title: "WebSession tied capability",
          requiredPermissions: ["view"],
        });
        sessionActions = {
          offer,
          fulfill,
          tie: {
            ok: tied.ok,
            claimedClass: tied instanceof ClaimedCapability,
            json: JSON.parse(JSON.stringify(tied)),
          },
          dropTied: await tied.drop(),
        };
      }
      let missing;
      try {
        await capability.call("missingMethod");
      } catch (error) {
        missing = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
          status: error?.details?.status,
        };
      }
      const drop = await capability.drop();
      return Response.json({
        ok: true,
        first,
        second,
        current,
        childClass: child instanceof ClaimedCapability,
        child: JSON.parse(JSON.stringify(child)),
        childFirst,
        readChild,
        sessionActions,
        missing,
        drop,
      });
    }

    if (url.pathname === "/claim-powerbox") {
      const sessionId = request.headers.get("x-sandstorm-session-id") || "";
      const token = url.searchParams.get("token") || "";
      const requiredPermissions = url.searchParams.getAll("requiredPermission");
      const permissionQuery = requiredPermissions
        .map((permission) => `&requiredPermission=${encodeURIComponent(permission)}`)
        .join("");
      let claimResponseOk = false;
      let claimResponseStatus = 500;
      let claim;
      if (url.searchParams.get("fetch") === "true") {
        claim = await sandstormPowerbox(request, env).claimRequest(token, {
          requiredPermissions,
        });
        claimResponseOk = true;
        claimResponseStatus = 200;
      } else {
        const claimResponse = await env.SANDSTORM_API.fetch(
          `http://sandstorm/powerbox/claim-request?` +
          `sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}` +
          permissionQuery,
          { method: "POST" });
        claimResponseOk = claimResponse.ok;
        claimResponseStatus = claimResponse.status;
        claim = await claimResponse.json();
      }
      const claimType = {
        claimedClass: claim instanceof ClaimedCapability,
        json: JSON.parse(JSON.stringify(claim)),
      };
      let save = null;
      let savedCapability = null;
      if (claim.ok && claim.id && url.searchParams.get("save") === "true") {
        const label = url.searchParams.get("label") || "Isolate test saved capability";
        if (typeof claim.save === "function") {
          savedCapability = await claim.save({ label });
          save = {
            status: 200,
            body: savedCapability,
            typed: {
              savedClass: savedCapability instanceof SavedCapability,
              json: JSON.parse(JSON.stringify(savedCapability)),
            },
          };
        } else {
          const saveResponse = await env.SANDSTORM_API.fetch(
            `http://sandstorm/powerbox/save?id=${encodeURIComponent(claim.id)}` +
            `&label=${encodeURIComponent(label)}`,
            { method: "POST" });
          save = {
            status: saveResponse.status,
            body: await saveResponse.json(),
          };
        }
      }
      let stored = null;
      if (save?.body?.ok && save.body.token && url.searchParams.get("store") === "true") {
        const key = url.searchParams.get("storageKey") || "saved-capability-token";
        const putResponse = await env.STORAGE.fetch(`http://storage/${encodeURIComponent(key)}`, {
          method: "PUT",
          body: save.body.token,
        });
        const getResponse = await env.STORAGE.fetch(`http://storage/${encodeURIComponent(key)}`);
        stored = {
          key,
          put: {
            status: putResponse.status,
            body: await putResponse.json(),
          },
          token: await getResponse.text(),
        };
      }
      let restore = null;
      let dropRestored = null;
      let restoredCapability = null;
      const restoreToken = stored?.token || save?.body?.token;
      if (restoreToken && url.searchParams.get("restore") === "true") {
        if (savedCapability && typeof savedCapability.restore === "function") {
          restoredCapability = await savedCapability.restore();
          restore = {
            status: 200,
            body: restoredCapability,
            typed: {
              restoredClass: restoredCapability instanceof ClaimedCapability,
              json: JSON.parse(JSON.stringify(restoredCapability)),
            },
          };
        } else {
          const restoreResponse = await env.SANDSTORM_API.fetch(
            `http://sandstorm/powerbox/restore?token=${encodeURIComponent(restoreToken)}`,
            { method: "POST" });
          restore = {
            status: restoreResponse.status,
            body: await restoreResponse.json(),
          };
        }
        if (restore.body.ok && restore.body.id) {
          if (restoredCapability && typeof restoredCapability.drop === "function") {
            dropRestored = {
              status: 200,
              body: await restoredCapability.drop(),
            };
          } else {
            const dropRestoredResponse = await env.SANDSTORM_API.fetch(
              `http://sandstorm/powerbox/drop?id=${encodeURIComponent(restore.body.id)}`,
              { method: "POST" });
            dropRestored = {
              status: dropRestoredResponse.status,
              body: await dropRestoredResponse.json(),
            };
          }
        }
      }
      let fetched = null;
      if (claim.ok && typeof claim.fetch === "function" && url.searchParams.get("fetch") === "true") {
        const fetchedResponse = await claim.fetch("/capability-echo?source=claim");
        fetched = {
          status: fetchedResponse.status,
          body: await fetchedResponse.json(),
        };
      }
      let offer = null;
      let fulfill = null;
      let tie = null;
      let dropTied = null;
      if (claim.ok && typeof claim.offer === "function" &&
          url.searchParams.get("sessionActions") === "true") {
        offer = await claim.offer(request, {
          title: "WebSession offered capability",
          requiredPermissions,
        });
        fulfill = await claim.fulfillRequest(request, {
          title: "WebSession fulfilled capability",
          requiredPermissions,
        });
        const tiedCapability = await claim.tieToUser(request, {
          title: "WebSession tied capability",
          requiredPermissions,
        });
        tie = {
          ok: tiedCapability.ok,
          claimedClass: tiedCapability instanceof ClaimedCapability,
          json: JSON.parse(JSON.stringify(tiedCapability)),
        };
        dropTied = await tiedCapability.drop();
      }
      let drop = null;
      if (claim.ok && claim.id) {
        if (typeof claim.drop === "function") {
          drop = {
            status: 200,
            body: await claim.drop(),
          };
        } else {
          const dropResponse = await env.SANDSTORM_API.fetch(
            `http://sandstorm/powerbox/drop?id=${encodeURIComponent(claim.id)}`,
            { method: "POST" });
          drop = {
            status: dropResponse.status,
            body: await dropResponse.json(),
          };
        }
      }
      let dropSaved = null;
      if (restoreToken && url.searchParams.get("dropSaved") === "true") {
        if (savedCapability && typeof savedCapability.drop === "function") {
          dropSaved = {
            status: 200,
            body: await savedCapability.drop(),
          };
        } else {
          const dropSavedResponse = await env.SANDSTORM_API.fetch(
            `http://sandstorm/powerbox/drop-saved?token=${encodeURIComponent(restoreToken)}`,
            { method: "POST" });
          dropSaved = {
            status: dropSavedResponse.status,
            body: await dropSavedResponse.json(),
          };
        }
      }
      return Response.json({
        ok: claimResponseOk,
        status: claimResponseStatus,
        sessionId,
        claim,
        claimType,
        save,
        stored,
        restore,
        fetched,
        offer,
        fulfill,
        tie,
        dropTied,
        dropRestored,
        drop,
        dropSaved,
      }, { status: claimResponseStatus });
    }

    const apiStatus = await (await env.SANDSTORM_API.fetch("http://sandstorm/status")).json();
    const apiCapabilities =
        await (await env.SANDSTORM_API.fetch("http://sandstorm/capabilities")).json();
    const apiRuntime = await (await env.SANDSTORM_API.fetch("http://sandstorm/runtime")).json();
    const apiModules = await (await env.SANDSTORM_API.fetch("http://sandstorm/modules")).json();
    const apiBindings = await (await env.SANDSTORM_API.fetch("http://sandstorm/bindings")).json();

    const storagePut = await (await env.STORAGE.fetch("http://storage/fixture", {
      method: "PUT",
      body: "stored from isolate",
    })).json();
    const storageHead = await env.STORAGE.fetch("http://storage/fixture", { method: "HEAD" });
    const storageText = await (await env.STORAGE.fetch("http://storage/fixture")).text();
    const storageIndex = await (await env.STORAGE.fetch("http://storage/")).json();
    const storageDelete =
        await (await env.STORAGE.fetch("http://storage/fixture", { method: "DELETE" })).json();
    const storageMissing = await env.STORAGE.fetch("http://storage/fixture");
    const storageIndexAfterDelete = await (await env.STORAGE.fetch("http://storage/")).json();

    return Response.json({
      ok: true,
      method: request.method,
      pathname: url.pathname,
      message,
      metadata,
      textBinding: env.TEXT_BINDING,
      jsonBinding: env.JSON_BINDING,
      sandstormApi: {
        status: apiStatus,
        capabilities: apiCapabilities,
        runtime: apiRuntime,
        modules: apiModules,
        bindings: apiBindings,
      },
      storage: {
        put: storagePut,
        head: {
          status: storageHead.status,
          bytes: storageHead.headers.get("x-sandstorm-storage-bytes"),
        },
        text: storageText,
        index: storageIndex,
        delete: storageDelete,
        missingStatus: storageMissing.status,
        indexAfterDelete: storageIndexAfterDelete,
      },
      headers,
    });
  },
};
