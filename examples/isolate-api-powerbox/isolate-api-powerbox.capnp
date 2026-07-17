@0xcfd526d45111ad0b;

using Grain = import "/sandstorm/grain.capnp";
using Spk = import "/sandstorm/package.capnp";

const viewInfo :Grain.UiView.ViewInfo = (
  appTitle = (defaultText = "Isolate API Powerbox"),

  permissions = [
    ( name = "view",
      title = (defaultText = "view"),
      description = (defaultText = "allows opening the API Powerbox example")
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
        esModulePath = "isolate-api-powerbox/worker.js"
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
      viewInfo = .viewInfo,
      apiPath = "/api/"
    )
  )
);

const pkgdef :Spk.PackageDefinition = (
  id = "8djwvme6h49v5p2zj57gatq698pyx4nkdnwgjpzfctgunfrzh4p0",

  manifest = (
    appTitle = (defaultText = "Isolate API Powerbox"),

    appVersion = 0,
    appMarketingVersion = (defaultText = "0.0.0"),

    actions = [
      ( title = (defaultText = "New API Powerbox Instance"),
        nounPhrase = (defaultText = "instance"),
        command = .command
      )
    ],

    continueCommand = .command
  ),

  sourceMap = (
    searchPath = [
      ( packagePath = "isolate-api-powerbox", sourcePath = "isolate-api-powerbox" )
    ]
  ),

  alwaysInclude = [ "sandstorm-manifest", "isolate-api-powerbox" ]
);
