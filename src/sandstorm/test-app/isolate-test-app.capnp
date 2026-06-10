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
        esModule = "export default { fetch(request, env, ctx) { return new Response('hello'); } };"
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
