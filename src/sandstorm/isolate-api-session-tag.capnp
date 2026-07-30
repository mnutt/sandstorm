@0xd5c7494599292e25;

# Internal capnp-es serialization layout for ApiSession.PowerboxTag.
#
# Powerbox tag values are matched structurally, so this dependency-free mirror lets sandstorm:api
# construct the value without embedding the full ApiSession -> IP networking -> Supervisor schema
# closure in every isolate package. Keep this layout in sync with ApiSession.PowerboxTag.
struct IsolateApiSessionPowerboxTag {
  canonicalUrl @0 :Text;

  struct OAuthScope {
    name @0 :Text;
  }

  oauthScopes @1 :List(OAuthScope);
}
