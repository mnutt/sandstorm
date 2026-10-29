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
set(SANDSTORM_ISOLATE_HOST_VERSION 0.1.1)
set(SANDSTORM_ISOLATE_HOST_SHA256
  90cb37f41437ea4835f4b14b094435c8b46a1a3c71f0a62368ab8d93b61c1cc6)
set(SANDSTORM_ISOLATE_HOST_BINARY_SHA256
  1e9747825067b4daed476a801f0b8584d49d44ec6906153a0a532a1afca6cbe7)
set(SANDSTORM_ISOLATE_HOST_EXECUTABLE "" CACHE FILEPATH
  "Optional prebuilt isolate-host executable for local development")
set(SANDSTORM_CAPNP_ES_NPM_VERSION 0.3.0 CACHE STRING
  "npm @mnutt/capnp-es version used for isolate schema generation")
set(SANDSTORM_CAPNP_ES_COMPILER_MODULE "" CACHE FILEPATH
  "Optional capnp-es compiler module override for local development")
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
