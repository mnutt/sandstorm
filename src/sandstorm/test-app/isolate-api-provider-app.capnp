@0xf45f30ce0563ad59;

using Grain = import "/sandstorm/grain.capnp";
using Powerbox = import "/sandstorm/powerbox.capnp";
using Spk = import "/sandstorm/package.capnp";
using TestApp = import "/sandstorm/test-app/test-app.capnp";

const providerTag :TestApp.TestPowerboxCap.PowerboxTag = (i = 123, s = "foo");

const providerDescriptor :Powerbox.PowerboxDescriptor = (
  tags = [
    (
      id = 0xdf9518c9479ddfcb,
      value = .providerTag
    )
  ]
);

const viewInfo :Grain.UiView.ViewInfo = (
  appTitle = (defaultText = "Isolate Capability Provider"),

  permissions = [
    ( name = "view",
      title = (defaultText = "view"),
      description = (defaultText = "allows opening the isolate capability provider")
    )
  ],

  roles = [
    ( title = (defaultText = "viewer"),
      permissions = [true],
      verbPhrase = (defaultText = "can view"),
      default = true
    )
  ],

  matchRequests = [
    .providerDescriptor
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
        esModulePath = "isolate-api-provider/worker.js"
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
      )
    ],

    bridgeConfig = (
      viewInfo = .viewInfo,
      apiPath = "/api/"
    )
  )
);

const pkgdef :Spk.PackageDefinition = (
  id = "mkhmn9rg2phfv3dvcnd71ud45jp70139h0e3sgqkh6rg2ydk3z00",

  manifest = (
    appTitle = (defaultText = "Isolate Capability Provider"),

    appVersion = 0,
    appMarketingVersion = (defaultText = "0.0.0"),

    actions = [
      ( title = (defaultText = "New Capability Provider"),
        nounPhrase = (defaultText = "provider"),
        command = .command
      )
    ],

    continueCommand = .command
  ),

  sourceMap = (
    searchPath = [
      ( packagePath = "isolate-api-provider", sourcePath = "isolate-api-provider" )
    ]
  ),

  alwaysInclude = [ "sandstorm-manifest", "isolate-api-provider" ]
);
