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
set(SANDSTORM_ISOLATE_HOST_VERSION 0.1.0)
set(SANDSTORM_ISOLATE_HOST_SHA256
  2861c648fca7a0a71ce69bde6f33cb5346b3dc0f71aba4ea65e0680ab3cac6fa)
set(SANDSTORM_ISOLATE_HOST_BINARY_SHA256
  b5ba1331842f998058fb05da679138adc35f8bc8ad62bcb0bc4fbf7ae2305dbc)
set(SANDSTORM_ISOLATE_HOST_EXECUTABLE "" CACHE FILEPATH
  "Optional prebuilt isolate-host executable for local development")
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
