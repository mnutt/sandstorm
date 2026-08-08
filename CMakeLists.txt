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
