include(ExternalProject)
include(FindPackageHandleStandardArgs)

find_package(Threads REQUIRED)

find_path(SANDSTORM_ZLIB_INCLUDE_DIR zlib.h REQUIRED)
if(NOT TARGET ZLIB::ZLIB)
  # Keep zlib as a linker name instead of an absolute library path. This lets
  # the static runtime binaries resolve libz.a while dynamic tools resolve the
  # shared library, matching the established Sandstorm link behavior.
  add_library(ZLIB::ZLIB INTERFACE IMPORTED GLOBAL)
  set_target_properties(ZLIB::ZLIB PROPERTIES
    INTERFACE_INCLUDE_DIRECTORIES "${SANDSTORM_ZLIB_INCLUDE_DIR}"
    INTERFACE_LINK_LIBRARIES z)
endif()

set(_sandstorm_saved_build_testing "${BUILD_TESTING}")
set(BUILD_TESTING OFF)

# BoringSSL is added before Cap'n Proto. Cap'n Proto's TLS target is defined
# below so that it uses the vendored BoringSSL rather than the host OpenSSL.
add_subdirectory(
  "${PROJECT_SOURCE_DIR}/deps/boringssl"
  "${CMAKE_BINARY_DIR}/_deps/boringssl"
  EXCLUDE_FROM_ALL)

set(WITH_OPENSSL OFF CACHE STRING
  "Use the separately-defined BoringSSL-backed kj-tls target" FORCE)
set(WITH_ZLIB ON CACHE STRING "Build KJ's zlib support" FORCE)
set(WITH_FIBERS OFF CACHE STRING "Disable KJ fibers" FORCE)
add_subdirectory(
  "${PROJECT_SOURCE_DIR}/deps/capnproto/c++"
  "${CMAKE_BINARY_DIR}/_deps/capnproto"
  EXCLUDE_FROM_ALL)

set(BUILD_TESTING "${_sandstorm_saved_build_testing}")
unset(_sandstorm_saved_build_testing)

# The vendored KJ/Cap'n Proto code requires these compatibility settings.
target_compile_features(kj PUBLIC cxx_std_17)
target_compile_definitions(kj PUBLIC KJ_STD_COMPAT KJ_HAS_LIBDL)
target_compile_options(kj PUBLIC "$<$<COMPILE_LANGUAGE:CXX>:-include;cstdint>")

add_library(kj-tls STATIC
  "${PROJECT_SOURCE_DIR}/deps/capnproto/c++/src/kj/compat/readiness-io.c++"
  "${PROJECT_SOURCE_DIR}/deps/capnproto/c++/src/kj/compat/tls.c++")
add_library(CapnProto::kj-tls ALIAS kj-tls)
target_compile_definitions(kj-tls PRIVATE KJ_HAS_OPENSSL)
target_link_libraries(kj-tls PUBLIC kj-async PRIVATE ssl crypto)

find_program(SANDSTORM_MAKE_EXECUTABLE NAMES gmake make REQUIRED)
set(SANDSTORM_SODIUM_BUILD_DIR "${CMAKE_BINARY_DIR}/_deps/libsodium")
file(MAKE_DIRECTORY
  "${SANDSTORM_SODIUM_BUILD_DIR}/src/libsodium/include")

ExternalProject_Add(sandstorm_libsodium_external
  SOURCE_DIR "${PROJECT_SOURCE_DIR}/deps/libsodium"
  BINARY_DIR "${SANDSTORM_SODIUM_BUILD_DIR}"
  CONFIGURE_COMMAND
    "${PROJECT_SOURCE_DIR}/deps/libsodium/configure"
      --disable-shared
      --enable-static
      --with-pic
      "CC=${CMAKE_C_COMPILER}"
  BUILD_COMMAND "${SANDSTORM_MAKE_EXECUTABLE}" -j
  INSTALL_COMMAND ""
  BUILD_BYPRODUCTS
    "${SANDSTORM_SODIUM_BUILD_DIR}/src/libsodium/.libs/libsodium.a")

add_library(sodium STATIC IMPORTED GLOBAL)
set_target_properties(sodium PROPERTIES
  IMPORTED_LOCATION
    "${SANDSTORM_SODIUM_BUILD_DIR}/src/libsodium/.libs/libsodium.a"
  INTERFACE_INCLUDE_DIRECTORIES
    "${PROJECT_SOURCE_DIR}/deps/libsodium/src/libsodium/include;${SANDSTORM_SODIUM_BUILD_DIR}/src/libsodium/include")
add_dependencies(sodium sandstorm_libsodium_external)

set(_sandstorm_seccomp_sources
  api.c
  system.c
  helper.c
  gen_pfc.c
  gen_bpf.c
  hash.c
  db.c
  arch.c
  arch-x86.c
  arch-x86_64.c
  arch-x32.c
  arch-arm.c
  arch-aarch64.c
  arch-mips.c
  arch-mips64.c
  arch-mips64n32.c
  arch-parisc.c
  arch-parisc64.c
  arch-ppc.c
  arch-ppc64.c
  arch-riscv64.c
  arch-s390.c
  arch-s390x.c
  arch-x86-syscalls.c
  arch-x86_64-syscalls.c
  arch-x32-syscalls.c
  arch-arm-syscalls.c
  arch-aarch64-syscalls.c
  arch-mips-syscalls.c
  arch-mips64-syscalls.c
  arch-mips64n32-syscalls.c
  arch-parisc-syscalls.c
  arch-ppc-syscalls.c
  arch-ppc64-syscalls.c
  arch-riscv64-syscalls.c
  arch-s390-syscalls.c
  arch-s390x-syscalls.c)
list(TRANSFORM _sandstorm_seccomp_sources
  PREPEND "${PROJECT_SOURCE_DIR}/deps/libseccomp/src/")

add_library(sandstorm_seccomp STATIC ${_sandstorm_seccomp_sources})
target_compile_definitions(sandstorm_seccomp PRIVATE PIC)
target_compile_options(sandstorm_seccomp PRIVATE -fvisibility=hidden)
target_include_directories(sandstorm_seccomp
  PUBLIC "${PROJECT_SOURCE_DIR}/src/libseccomp/include"
  PRIVATE
    "${PROJECT_SOURCE_DIR}/src/libseccomp"
    "${PROJECT_SOURCE_DIR}/deps/libseccomp/src")

add_library(sandstorm_build_options INTERFACE)
target_compile_definitions(sandstorm_build_options INTERFACE
  "SANDSTORM_BUILD=${SANDSTORM_BUILD}"
  KJ_STD_COMPAT
  KJ_HAS_LIBDL)
target_compile_features(sandstorm_build_options INTERFACE cxx_std_17)
target_compile_options(sandstorm_build_options INTERFACE
  "$<$<COMPILE_LANGUAGE:CXX>:-include;cstdint>")
target_link_libraries(sandstorm_build_options INTERFACE Threads::Threads)

add_library(sandstorm_warnings INTERFACE)
target_compile_options(sandstorm_warnings INTERFACE
  "$<$<COMPILE_LANGUAGE:CXX>:-Wall;-Wextra;-Wno-sign-compare;-Wno-unused-parameter>"
  "$<$<COMPILE_LANG_AND_ID:CXX,Clang,AppleClang>:-Wglobal-constructors>"
  "$<$<COMPILE_LANGUAGE:C>:-Wall>")
