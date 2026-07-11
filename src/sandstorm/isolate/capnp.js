// Public schema integration facade for isolate applications. Bridge and transport
// implementation details live in the internal runtime module.
export {
  CapnpUnavailableError,
  byteStreamFromWritable,
  capnpClient,
  createCapnpStruct,
  exportCapnp,
  readCapnpStruct,
  writableFromByteStream,
} from "sandstorm-internal:capnp-runtime";
