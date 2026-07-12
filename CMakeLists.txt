cmake_minimum_required(VERSION 3.25)

project(Sandstorm LANGUAGES C CXX)

if(NOT CMAKE_SYSTEM_NAME STREQUAL "Linux")
  message(FATAL_ERROR "Sandstorm's native build currently supports Linux only.")
endif()

if(NOT CMAKE_GENERATOR MATCHES "Ninja")
  message(WARNING "The Sandstorm build is tested with Ninja; generator is '${CMAKE_GENERATOR}'.")
endif()

if(NOT CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  message(WARNING
    "Sandstorm is built and tested with Clang; '${CMAKE_CXX_COMPILER_ID}' "
    "may not compile the current Cap'n Proto API usage.")
endif()

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS ON)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib")
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib")

set(SANDSTORM_BUILD 0 CACHE STRING "Sandstorm release build number")
set(SANDSTORM_WORKERD_NPM_VERSION 1.20260610.1 CACHE STRING
  "npm workerd version bundled for isolate grains")
set(SANDSTORM_WORKERD_SOURCE_COMMIT ea5e86d22f16996a3d8fdb8922c34eb7e8711cd3
  CACHE STRING "Pinned workerd source commit")
set(SANDSTORM_BAZEL_VERSION 9.1.0 CACHE STRING
  "Bazel version used to build the embedded workerd host")
set(SANDSTORM_BAZEL_LINUX_X86_64_SHA256
  a667454f3f4f8878df8199136b82c199f6ada8477b337fae3b1ef854f01e4e2f
  CACHE STRING "SHA-256 for the pinned Bazel Linux x86-64 binary")
set(SANDSTORM_WORKERD_BIN "" CACHE FILEPATH
  "Optional prebuilt workerd binary to bundle instead of installing from npm")
set(SANDSTORM_CAPNP_ES_NPM_VERSION 0.3.0 CACHE STRING
  "npm @mnutt/capnp-es version used for isolate schema generation")
set(SANDSTORM_CAPNP_ES_COMPILER_MODULE "" CACHE FILEPATH
  "Optional capnp-es compiler module override for local development")
option(SANDSTORM_BUILD_NODE_CAPNP "Build the capnp.node addon" ON)
option(SANDSTORM_BUILD_FRONTEND "Enable Meteor shell build targets" ON)
option(SANDSTORM_STATIC_RUNTIME_BINARIES
  "Statically link the sandbox runtime binaries" ON)
set(SANDSTORM_STODGY_TESTER "$ENV{HOME}/.local/bin/stodgy-tester" CACHE FILEPATH
  "Path to stodgy-tester for the installer test suite")

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")

include(CTest)
include(SandstormDependencies)

add_subdirectory(src/bpf_asm)
add_subdirectory(src/sandstorm)

add_custom_target(installer-test
  COMMAND bash "${PROJECT_SOURCE_DIR}/installer-tests/prepare-for-tests.sh"
  COMMAND "${CMAKE_COMMAND}" -E env
    "PYTHONUNBUFFERED=yes"
    "TERM=xterm"
    "SLOW_TEXT_TIMEOUT=120"
    "${SANDSTORM_STODGY_TESTER}"
      --plugin stodgy_tester.plugins.sandstorm_installer_tests
      --on-vm-start=uninstall_sandstorm
      --rsync
  WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}/installer-tests"
  USES_TERMINAL
  COMMENT "Running the Sandstorm installer test suite"
  VERBATIM)
