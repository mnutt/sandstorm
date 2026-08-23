@0x98d17f82c78a9141;

using Grain = import "/sandstorm/grain.capnp";
using Spk = import "/sandstorm/package.capnp";

const viewInfo :Grain.UiView.ViewInfo = (
  appTitle = (defaultText = "Browser Capnp Counter"),

  permissions = [
    ( name = "view",
      title = (defaultText = "view"),
      description = (defaultText = "allows opening the browser Capnp counter")
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

const command :Spk.Manifest.Command = (
  isolate = (
    mainModule = "worker.js",
    compatibilityDate = "2025-01-01",
    compatibilityFlags = [],

    modules = [
      (
        name = "worker.js",
        esModulePath = "isolate-browser-capnp/worker.js"
      )
    ],

    bindings = [
      (
        name = "SANDSTORM_API",
        sandstormApi = void
      ),
      (
        name = "POWERBOX",
        powerbox = void
      ),
      (
        name = "STORAGE",
        storage = void
      )
    ],

    bridgeConfig = (
      viewInfo = .viewInfo
    )
  )
);

const pkgdef :Spk.PackageDefinition = (
  id = "k7tvjx2asx9rqe0y064r5jxcwwy68fase72pk3qat4ud1ttuwyk0",

  manifest = (
    appTitle = (defaultText = "Browser Capnp Counter"),

    appVersion = 0,
    appMarketingVersion = (defaultText = "0.0.0"),

    actions = [
      ( title = (defaultText = "New Browser Capnp Counter"),
        nounPhrase = (defaultText = "counter"),
        command = .command
      )
    ],

    continueCommand = .command
  ),

  sourceMap = (
    searchPath = [
      ( packagePath = "isolate-browser-capnp", sourcePath = "isolate-browser-capnp" )
    ]
  ),

  alwaysInclude = [ "sandstorm-manifest", "isolate-browser-capnp" ]
);
