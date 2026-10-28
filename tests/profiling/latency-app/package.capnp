@0xb8ec1439a26f84ac;
using Spk = import "/sandstorm/package.capnp";
# Public, test-only signing key. Never use this identity for a real application.
const pkgdef :Spk.PackageDefinition = (
  id = "3xy5znmjhrfs9ujsjq084w4rky96e8g25uwve0qkmekjzkmfgpv0",
  manifest = (
    appTitle = (defaultText = "Sandstorm Request Latency"),
    appVersion = 0,
    appMarketingVersion = (defaultText = "0.0.0"),
    actions = [(title = (defaultText = "New latency grain"), nounPhrase = (defaultText = "grain"),
      command = (argv = ["/sandstorm-http-bridge", "8000", "--", "/latency-test-app", "8000"]))],
    continueCommand = (argv = ["/sandstorm-http-bridge", "8000", "--", "/latency-test-app", "8000"])
  ),
  bridgeConfig = (),
  sourceMap = (searchPath = [(sourcePath = ".")]),
  alwaysInclude = ["latency-test-app", "sandstorm-http-bridge", "sandstorm-manifest", "sandstorm-http-bridge-config"]
);
