fn main() {
    println!("cargo:rerun-if-changed=../schema/shell.capnp");
    println!("cargo:rerun-if-changed=../schema/fixture.capnp");
    capnpc::CompilerCommand::new()
        .src_prefix("../schema")
        .file("../schema/shell.capnp")
        .file("../schema/fixture.capnp")
        .run()
        .expect("compile shell schema (install the capnp compiler)");
}
