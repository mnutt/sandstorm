@0xc8e3edc483c13768;

using Grain = import "/sandstorm/grain.capnp";
using Spk = import "/sandstorm/package.capnp";

# Local validation package for the account-shared isolate runtime path.
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

const isolateBindings :List(Spk.Manifest.IsolateConfig.Binding) = [
  (
    name = "TEXT_BINDING",
    text = "hello from a text binding"
  ),
  (
    name = "JSON_BINDING",
    json = "{\"binding\":\"json\"}"
  ),
  (
    name = "DATA_BINDING",
    data = "\x00\x01\x7f\x80\xffSandstorm"
  ),
  (
    name = "SANDSTORM_API",
    sandstormApi = void
  ),
  (
    name = "LOOPBACK_SERVICE",
    service = "main"
  )
];

const isolateCommand :Spk.Manifest.Command = (
  isolate = (
    mainModule = "worker.js",
    compatibilityDate = "2025-01-01",
    compatibilityFlags = [],

    exports = [
      (name = "greeter", interfaceId = 0xb66316217ceedb1b),
      (name = "ui", interfaceId = 0xc277e9822ae2c8fc)
    ],

    modules = [
      (
        name = "worker.js",
        esModulePath = "isolate-test/worker.js"
      ),
      (
        name = "message.txt",
        textPath = "isolate-test/message.txt"
      ),
      (
        name = "metadata.json",
        jsonPath = "isolate-test/metadata.json"
      )
    ],

    bindings = .isolateBindings,

    bridgeConfig = (
      viewInfo = .isolateTestViewInfo,
      apiPath = "/api/"
    )
  )
);

const isolateMainViewCommand :Spk.Manifest.Command = (
  isolate = (
    mainModule = "main-view-worker.js",
    compatibilityDate = "2025-01-01",
    compatibilityFlags = [],

    exports = [
      (name = "greeter", interfaceId = 0xb66316217ceedb1b),
      (name = "ui", interfaceId = 0xc277e9822ae2c8fc, role = mainView)
    ],

    modules = [
      (
        name = "main-view-worker.js",
        esModulePath = "isolate-test/worker.js"
      ),
      (
        name = "message.txt",
        textPath = "isolate-test/message.txt"
      ),
      (
        name = "metadata.json",
        jsonPath = "isolate-test/metadata.json"
      )
    ],

    bindings = .isolateBindings
  )
);

const isolateServiceCommand :Spk.Manifest.Command = (
  isolate = (
    mainModule = "service-worker.js",
    compatibilityDate = "2025-01-01",
    compatibilityFlags = [],

    exports = [
      (name = "greeter", interfaceId = 0xb66316217ceedb1b)
    ],

    modules = [
      (
        name = "service-worker.js",
        esModulePath = "isolate-test/service-worker.js"
      )
    ],

    bindings = []
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
      ),
      ( title = (defaultText = "New Direct MainView Test Instance"),
        nounPhrase = (defaultText = "direct MainView instance"),
        command = .isolateMainViewCommand
      ),
      ( title = (defaultText = "New Service-only Test Instance"),
        nounPhrase = (defaultText = "service"),
        command = .isolateServiceCommand,
        output = (
          capability = (
            exportName = "greeter",
            interfaceId = 0xb66316217ceedb1b,
            descriptor = (tags = [(id = 0xb66316217ceedb1b)]),
            displayInfo = (
              title = (defaultText = "Service-only greeter"),
              verbPhrase = (defaultText = "can greet"),
              description = (defaultText = "A typed greeter with no browser UI")
            )
          )
        )
      )
    ],

    continueCommand = .isolateCommand
  ),

  sourceMap = (
    searchPath = [
      ( packagePath = "isolate-test", sourcePath = "isolate-test" )
    ]
  ),

  alwaysInclude = [ "sandstorm-manifest", "isolate-test" ]
);
