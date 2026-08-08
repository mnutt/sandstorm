cmake_minimum_required(VERSION 3.20)

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

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")

include(CTest)
include(SandstormDependencies)

add_subdirectory(src/bpf_asm)
add_subdirectory(src/sandstorm)
