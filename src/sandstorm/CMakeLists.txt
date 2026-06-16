include(SandstormCapnp)
include(SandstormFrontend)
include(SandstormInstall)
include(SandstormNodeCapnp)
include(SandstormPackaging)

set(_sandstorm_schema_relative_paths
  activity.capnp
  api-session-impl.capnp
  api-session.capnp
  appid-replacements-test.capnp
  appid-replacements.capnp
  backend.capnp
  bridge-proxy.capnp
  control-socket.capnp
  email-impl.capnp
  email.capnp
  grain.capnp
  hack-session.capnp
  identity-impl.capnp
  identity.capnp
  isolate-supervisor-internal.capnp
  ip.capnp
  mime.capnp
  package.capnp
  payments.capnp
  persistentuiview.capnp
  powerbox.capnp
  sandstorm-http-bridge-internal.capnp
  sandstorm-http-bridge.capnp
  supervisor.capnp
  update-tool.capnp
  util.capnp
  web-publishing.capnp
  web-session.capnp
  app-index/app-index.capnp
  app-index/keybase-api.capnp
  app-index/submit.capnp
  test-app/test-app.capnp)

list(TRANSFORM _sandstorm_schema_relative_paths
  PREPEND "${CMAKE_CURRENT_SOURCE_DIR}/"
  OUTPUT_VARIABLE _sandstorm_schemas)

sandstorm_generate_capnp(_sandstorm_schema_sources _sandstorm_schema_headers
  ${_sandstorm_schemas})

set(_capnweb_package_dir "${PROJECT_SOURCE_DIR}/deps/capnweb-npm")
set(_capnweb_work_dir "${CMAKE_BINARY_DIR}/capnweb-npm")
set(_capnweb_js "${_capnweb_work_dir}/node_modules/capnweb/dist/index.js")
add_custom_command(
  OUTPUT "${_capnweb_js}"
  COMMAND "${CMAKE_COMMAND}" -E remove_directory "${_capnweb_work_dir}"
  COMMAND "${CMAKE_COMMAND}" -E make_directory "${_capnweb_work_dir}"
  COMMAND "${CMAKE_COMMAND}" -E copy
    "${_capnweb_package_dir}/package.json"
    "${_capnweb_package_dir}/package-lock.json"
    "${_capnweb_work_dir}"
  COMMAND "${CMAKE_COMMAND}" -E env
    "PATH=${SANDSTORM_METEOR_DEV_BUNDLE}/bin:$ENV{PATH}"
    "${SANDSTORM_METEOR_DEV_BUNDLE}/bin/npm" ci
      --no-fund --prefix "${_capnweb_work_dir}"
  COMMAND "${SANDSTORM_METEOR_DEV_BUNDLE}/bin/node" -e
    "const v=require('${_capnweb_work_dir}/node_modules/capnweb/package.json').version;if(v!=='${SANDSTORM_CAPNWEB_NPM_VERSION}')process.exit(1)"
  DEPENDS
    "${_capnweb_package_dir}/package.json"
    "${_capnweb_package_dir}/package-lock.json"
  COMMENT "Installing the isolate capnweb runtime from npm"
  VERBATIM)

set(_isolate_generated_headers)
function(_sandstorm_embed_isolate_js input name variable)
  set(_output "${CMAKE_BINARY_DIR}/generated/sandstorm/isolate/${name}.js.h")
  add_custom_command(
    OUTPUT "${_output}"
    COMMAND "${CMAKE_COMMAND}"
      "-DINPUT=${input}"
      "-DOUTPUT=${_output}"
      "-DVARIABLE=${variable}"
      -P "${PROJECT_SOURCE_DIR}/cmake/EmbedJs.cmake"
    DEPENDS "${input}" "${PROJECT_SOURCE_DIR}/cmake/EmbedJs.cmake"
    COMMENT "Embedding isolate runtime ${name}.js"
    VERBATIM)
  set(_isolate_generated_headers ${_isolate_generated_headers} "${_output}" PARENT_SCOPE)
endfunction()

_sandstorm_embed_isolate_js(
  "${CMAKE_CURRENT_SOURCE_DIR}/isolate/api.js" api ISOLATE_API_HELPER_SOURCE)
_sandstorm_embed_isolate_js(
  "${_capnweb_js}" capnweb CAPNWEB_SOURCE)
_sandstorm_embed_isolate_js(
  "${CMAKE_CURRENT_SOURCE_DIR}/isolate/rpc.js" rpc ISOLATE_RPC_HELPER_SOURCE)

add_library(sandstorm_schemas STATIC
  ${_sandstorm_schema_sources}
  ${_sandstorm_schema_headers})
target_include_directories(sandstorm_schemas PUBLIC
  "${CMAKE_BINARY_DIR}/generated"
  "${PROJECT_SOURCE_DIR}/src")
target_link_libraries(sandstorm_schemas PUBLIC
  sandstorm_build_options
  CapnProto::capnp-rpc)

add_library(sandstorm_core STATIC
  ${_isolate_generated_headers}
  appid-replacements.c++
  backend.c++
  backup.c++
  bridge-proxy.c++
  cgroup2.c++
  config.c++
  fuse.c++
  gateway.c++
  id-to-text.c++
  isolate-supervisor.c++
  sandbox.c++
  send-fd.c++
  smtp-proxy.c++
  spk.c++
  supervisor.c++
  union-fs.c++
  util.c++
  util/http.c++
  web-session-bridge.c++
  "${PROJECT_SOURCE_DIR}/src/joyent-http/http_parser.c++"
  "${SANDSTORM_BPF_FILTER_HEADER}")
add_dependencies(sandstorm_core sandstorm_seccomp_filter)
target_include_directories(sandstorm_core PUBLIC
  "${PROJECT_SOURCE_DIR}/src"
  "${CMAKE_BINARY_DIR}/generated")
target_link_libraries(sandstorm_core
  PUBLIC
    sandstorm_build_options
    sandstorm_schemas
  PRIVATE
    sandstorm_warnings
    CapnProto::capnp-json
    capnpc
    CapnProto::kj-http
    CapnProto::kj-tls
    CapnProto::kj-gzip
    sodium
    sandstorm_seccomp
    "${CMAKE_DL_LIBS}"
    rt)

function(sandstorm_add_executable target source)
  add_executable("${target}" "${source}")
  target_link_libraries("${target}" PRIVATE
    sandstorm_core
    sandstorm_warnings)
endfunction()

function(sandstorm_make_static target)
  if(SANDSTORM_STATIC_RUNTIME_BINARIES)
    target_link_options("${target}" PRIVATE -static)
    set_target_properties("${target}" PROPERTIES
      LINK_SEARCH_START_STATIC ON
      LINK_SEARCH_END_STATIC ON)
  endif()
endfunction()

sandstorm_add_executable(sandstorm run-bundle.c++)
sandstorm_make_static(sandstorm)

sandstorm_add_executable(spk spk-standalone.c++)

sandstorm_add_executable(isolate-websession-client isolate-websession-client.c++)

sandstorm_add_executable(sandstorm-http-bridge sandstorm-http-bridge.c++)
sandstorm_make_static(sandstorm-http-bridge)

sandstorm_add_executable(update-tool update-tool.c++)
sandstorm_add_executable(fuse-test-bind fuse-test-bind.c++)

add_library(sandstorm_app_index STATIC
  app-index/indexer.c++
  app-index/keybase.c++)
target_link_libraries(sandstorm_app_index
  PUBLIC sandstorm_core
  PRIVATE sandstorm_warnings)
add_executable(app-index app-index/app-index.c++)
target_link_libraries(app-index PRIVATE
  sandstorm_app_index
  sandstorm_warnings)

sandstorm_add_executable(test-app test-app/test-app.c++)
sandstorm_make_static(test-app)

if(BUILD_TESTING)
  foreach(_test IN ITEMS appid-replacements id-to-text util)
    set(_target "sandstorm-${_test}-test")
    add_executable("${_target}" "${_test}-test.c++")
    target_link_libraries("${_target}" PRIVATE
      sandstorm_core
      CapnProto::kj-test)
    add_test(NAME "sandstorm/${_test}" COMMAND "$<TARGET_FILE:${_target}>")
  endforeach()
endif()

if(SANDSTORM_BUILD_NODE_CAPNP)
  sandstorm_add_node_capnp()
endif()

sandstorm_install_native()
sandstorm_add_frontend_targets()
sandstorm_add_packaging_targets()
