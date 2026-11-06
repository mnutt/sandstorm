@0xc5b7a74f8a8c3ef1;

using Email = import "email.capnp";
$import "/capnp/c++.capnp".namespace("sandstorm::test");

interface EmailRpcProbe {
  getMail @0 () -> (port :Email.EmailSendPort);
  ping @1 ();
  # A separate backend operation, independent of the forwarded email capability.
}
