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
  isolate-account-host.capnp
  isolate-authoring-impl.capnp
  isolate-authoring.capnp
  isolate-bridge.capnp
  isolate-host.capnp
  isolate-supervisor-internal.capnp
  isolate-worker-source.capnp
  ip.capnp
  mime.capnp
  package.capnp
  outbound-http-session-impl.capnp
  outbound-http-session.capnp
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
list(APPEND _sandstorm_schemas
  "${PROJECT_SOURCE_DIR}/deps/capnproto/c++/src/capnp/compat/byte-stream.capnp"
  "${PROJECT_SOURCE_DIR}/deps/capnproto/c++/src/capnp/compat/http-over-capnp.capnp")

sandstorm_generate_capnp(_sandstorm_schema_sources _sandstorm_schema_headers
  ${_sandstorm_schemas})

set(_isolate_generated_headers)
find_package(Python3 COMPONENTS Interpreter REQUIRED)
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

set(_isolate_api_header
  "${CMAKE_BINARY_DIR}/generated/sandstorm/isolate/api.js.h")
add_custom_command(
  OUTPUT "${_isolate_api_header}"
  COMMAND "${Python3_EXECUTABLE}"
    "${PROJECT_SOURCE_DIR}/cmake/EmbedIsolateApi.py"
    "${CMAKE_CURRENT_SOURCE_DIR}/isolate/api.js"
    "${CMAKE_CURRENT_SOURCE_DIR}/isolate/browser-client.js"
    "${CMAKE_CURRENT_SOURCE_DIR}/isolate/validation.js"
    "${_isolate_api_header}"
  DEPENDS
    "${PROJECT_SOURCE_DIR}/cmake/EmbedIsolateApi.py"
    "${CMAKE_CURRENT_SOURCE_DIR}/isolate/api.js"
    "${CMAKE_CURRENT_SOURCE_DIR}/isolate/browser-client.js"
    "${CMAKE_CURRENT_SOURCE_DIR}/isolate/validation.js"
  COMMENT "Embedding isolate API JavaScript"
  VERBATIM)
list(APPEND _isolate_generated_headers "${_isolate_api_header}")

_sandstorm_embed_isolate_js(
  "${CMAKE_CURRENT_SOURCE_DIR}/isolate/capnp-runtime.js"
  capnp-runtime ISOLATE_CAPNP_RUNTIME_SOURCE)

set(_capnp_es_runtime_header
  "${CMAKE_BINARY_DIR}/generated/sandstorm/isolate/capnp-es.js.h")
add_custom_command(
  OUTPUT "${_capnp_es_runtime_header}"
  COMMAND "${Python3_EXECUTABLE}"
    "${PROJECT_SOURCE_DIR}/cmake/EmbedCapnpEsRuntime.py"
    "${_capnp_es_runtime_header}"
    "${CMAKE_CURRENT_SOURCE_DIR}/isolate/capnp-es/runtime-modules.txt"
    "${CMAKE_BINARY_DIR}/capnp-es-npm/node_modules/@mnutt/capnp-es/dist"
  DEPENDS
    "${CMAKE_BINARY_DIR}/capnp-es-npm/node_modules/@mnutt/capnp-es/dist/compiler/index.mjs"
    "${CMAKE_CURRENT_SOURCE_DIR}/isolate/capnp-es/runtime-modules.txt"
    "${PROJECT_SOURCE_DIR}/cmake/EmbedCapnpEsRuntime.py"
  COMMENT "Embedding the capnp-es isolate runtime"
  VERBATIM)
list(APPEND _isolate_generated_headers "${_capnp_es_runtime_header}")

set(_platform_capnp_es_manifest
  "${CMAKE_CURRENT_SOURCE_DIR}/isolate/platform-capnp-es/schemas.txt")
file(STRINGS "${_platform_capnp_es_manifest}" _platform_capnp_es_schema_paths
  REGEX "^[^#].*\\.capnp$")
list(TRANSFORM _platform_capnp_es_schema_paths
  PREPEND "${PROJECT_SOURCE_DIR}/src/")
if(SANDSTORM_CAPNP_ES_COMPILER_MODULE)
  set(_platform_capnp_es_compiler "${SANDSTORM_CAPNP_ES_COMPILER_MODULE}")
else()
  set(_platform_capnp_es_compiler
    "${CMAKE_BINARY_DIR}/capnp-es-npm/node_modules/@mnutt/capnp-es/dist/compiler/index.mjs")
endif()
set(_platform_capnp_es_header
  "${CMAKE_BINARY_DIR}/generated/sandstorm/isolate/platform-capnp-es.js.h")
add_custom_command(
  OUTPUT "${_platform_capnp_es_header}"
  COMMAND "${Python3_EXECUTABLE}"
    "${PROJECT_SOURCE_DIR}/cmake/EmbedPlatformCapnpEs.py"
    "${_platform_capnp_es_header}"
    "${_platform_capnp_es_manifest}"
    "${SANDSTORM_METEOR_DEV_BUNDLE}/bin/node"
    "$<TARGET_FILE:capnp_tool>"
    "${_platform_capnp_es_compiler}"
    "${PROJECT_SOURCE_DIR}/src"
  DEPENDS
    "${PROJECT_SOURCE_DIR}/cmake/EmbedPlatformCapnpEs.py"
    "${_platform_capnp_es_manifest}"
    ${_platform_capnp_es_schema_paths}
    "${_platform_capnp_es_compiler}"
    capnp_tool
  COMMENT "Generating isolate platform capnp-es modules"
  VERBATIM)
list(APPEND _isolate_generated_headers "${_platform_capnp_es_header}")

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
  generated-isolate-package.c++
  id-to-text.c++
  isolate-capnp-framing.c++
  isolate-native-host-launch.c++
  isolate-session-registry.c++
  isolate-supervisor.c++
  isolate-util.c++
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
  "${PROJECT_SOURCE_DIR}/deps/capnproto/c++/src/capnp/compat/byte-stream.c++"
  "${PROJECT_SOURCE_DIR}/deps/capnproto/c++/src/capnp/compat/http-over-capnp.c++"
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

sandstorm_add_executable(isolate-host-client isolate-host-client.c++)
sandstorm_add_executable(isolate-account-host-client isolate-account-host-client.c++)
sandstorm_add_executable(isolate-backend-recovery-client isolate-backend-recovery-client.c++)
sandstorm_add_executable(isolate-host-memory-client isolate-host-memory-client.c++)

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
  foreach(_test IN ITEMS appid-replacements id-to-text isolate-util util)
    set(_target "sandstorm-${_test}-test")
    add_executable("${_target}" "${_test}-test.c++")
    target_link_libraries("${_target}" PRIVATE
      sandstorm_core
      CapnProto::kj-test)
    add_test(NAME "sandstorm/${_test}" COMMAND "$<TARGET_FILE:${_target}>")
  endforeach()

  add_executable(sandstorm-isolate-session-registry-test
    isolate-session-registry-test.c++)
  target_link_libraries(sandstorm-isolate-session-registry-test PRIVATE
    sandstorm_core
    CapnProto::kj-test)
  add_test(NAME sandstorm/isolate-session-registry
    COMMAND "$<TARGET_FILE:sandstorm-isolate-session-registry-test>")

  add_executable(sandstorm-generated-isolate-package-test
    generated-isolate-package-test.c++)
  target_link_libraries(sandstorm-generated-isolate-package-test PRIVATE
    sandstorm_core
    CapnProto::kj-test)
  add_test(NAME sandstorm/generated-isolate-package
    COMMAND "$<TARGET_FILE:sandstorm-generated-isolate-package-test>")
endif()

if(SANDSTORM_BUILD_NODE_CAPNP)
  sandstorm_add_node_capnp()
endif()

sandstorm_install_native()
sandstorm_add_frontend_targets()
sandstorm_add_packaging_targets()
