@0xc8e3edc483c13768;

using Grain = import "/sandstorm/grain.capnp";
using Spk = import "/sandstorm/package.capnp";

# Local validation package for the isolate supervisor sidecar path.
#
# This uses a dedicated checked-in test key so local validation cannot collide with the legacy
# test app's app ID or grains.

const isolateTestViewInfo :Grain.UiView.ViewInfo = (
  appTitle = (defaultText = "Sandstorm Isolate Test App"),

  permissions = [
    ( name = "view",
      title = (defaultText = "view"),
      description = (defaultText = "allows opening the isolate test app")
    )
  ],

  roles = [
    ( title = (defaultText = "viewer"),
      permissions = [true],
      verbPhrase = (defaultText = "can view"),
      default = true
    )
  ]
);

const isolateCommand :Spk.Manifest.Command = (
  argv = [
    "workerd",
    "serve",
    "${SANDSTORM_ISOLATE_WORKERD_CONFIG}",
    "sandstormConfig"
  ],

  isolate = (
    mainModule = "worker.js",
    compatibilityDate = "2025-01-01",
    compatibilityFlags = [],

    modules = [
      (
        name = "worker.js",
        esModule = "import message from \"message.txt\"; import metadata from \"metadata.json\"; export default { async fetch(request, env, ctx) { const url = new URL(request.url); const headers = {}; for (const [name, value] of request.headers) { if (name.startsWith(\"x-sandstorm-\") || name === \"host\") headers[name] = value; } const apiStatus = await (await env.SANDSTORM_API.fetch(\"http://sandstorm/status\")).json(); const apiCapabilities = await (await env.SANDSTORM_API.fetch(\"http://sandstorm/capabilities\")).json(); const apiRuntime = await (await env.SANDSTORM_API.fetch(\"http://sandstorm/runtime\")).json(); const apiModules = await (await env.SANDSTORM_API.fetch(\"http://sandstorm/modules\")).json(); const apiBindings = await (await env.SANDSTORM_API.fetch(\"http://sandstorm/bindings\")).json(); const storagePut = await (await env.STORAGE.fetch(\"http://storage/fixture\", { method: \"PUT\", body: \"stored from isolate\" })).json(); const storageHead = await env.STORAGE.fetch(\"http://storage/fixture\", { method: \"HEAD\" }); const storageText = await (await env.STORAGE.fetch(\"http://storage/fixture\")).text(); const storageIndex = await (await env.STORAGE.fetch(\"http://storage/\")).json(); const storageDelete = await (await env.STORAGE.fetch(\"http://storage/fixture\", { method: \"DELETE\" })).json(); const storageMissing = await env.STORAGE.fetch(\"http://storage/fixture\"); const storageIndexAfterDelete = await (await env.STORAGE.fetch(\"http://storage/\")).json(); return Response.json({ ok: true, method: request.method, pathname: url.pathname, message, metadata, textBinding: env.TEXT_BINDING, jsonBinding: env.JSON_BINDING, sandstormApi: { status: apiStatus, capabilities: apiCapabilities, runtime: apiRuntime, modules: apiModules, bindings: apiBindings }, storage: { put: storagePut, head: { status: storageHead.status, bytes: storageHead.headers.get(\"x-sandstorm-storage-bytes\") }, text: storageText, index: storageIndex, delete: storageDelete, missingStatus: storageMissing.status, indexAfterDelete: storageIndexAfterDelete }, headers }); } };"
      ),
      (
        name = "message.txt",
        text = "hello from a text module"
      ),
      (
        name = "metadata.json",
        json = "{\"fixture\":\"isolate-test-app\"}"
      )
    ],

    bindings = [
      (
        name = "TEXT_BINDING",
        text = "hello from a text binding"
      ),
      (
        name = "JSON_BINDING",
        json = "{\"binding\":\"json\"}"
      ),
      (
        name = "SANDSTORM_API",
        sandstormApi = void
      ),
      (
        name = "STORAGE",
        storage = void
      )
    ],

    bridgeConfig = (
      viewInfo = .isolateTestViewInfo,
      apiPath = "/api/"
    )
  )
);

const pkgdef :Spk.PackageDefinition = (
  id = "d2jw0rpnkydeupwend6dk0ugfkz3xfkygg21awx478pzz29gdtp0",

  manifest = (
    appTitle = (defaultText = "Sandstorm Isolate Test App"),

    appVersion = 0,
    appMarketingVersion = (defaultText = "0.0.0"),

    actions = [
      ( title = (defaultText = "New Isolate Test App Instance"),
        nounPhrase = (defaultText = "instance"),
        command = .isolateCommand
      )
    ],

    continueCommand = .isolateCommand
  ),

  alwaysInclude = [ "sandstorm-manifest" ]
);
