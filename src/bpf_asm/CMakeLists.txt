find_package(BISON REQUIRED)
find_package(FLEX REQUIRED)

set(_generated_dir "${CMAKE_CURRENT_BINARY_DIR}/generated")
file(MAKE_DIRECTORY "${_generated_dir}")

BISON_TARGET(bpf_parser
  "${CMAKE_CURRENT_SOURCE_DIR}/bpf_exp.y"
  "${_generated_dir}/bpf_exp.yacc.c"
  DEFINES_FILE "${_generated_dir}/bpf_exp.yacc.h")
FLEX_TARGET(bpf_lexer
  "${CMAKE_CURRENT_SOURCE_DIR}/bpf_exp.l"
  "${_generated_dir}/bpf_exp.lex.c")
ADD_FLEX_BISON_DEPENDENCY(bpf_lexer bpf_parser)

add_executable(bpf_asm
  bpf_asm.c
  ${BISON_bpf_parser_OUTPUTS}
  ${FLEX_bpf_lexer_OUTPUTS})
target_include_directories(bpf_asm PRIVATE "${_generated_dir}")

add_executable(sandstorm_seccomp_constants
  "${PROJECT_SOURCE_DIR}/src/sandstorm/seccomp-bpf/gen-clean-h.c")

set(_sandstorm_seccomp_dir
  "${CMAKE_BINARY_DIR}/generated/sandstorm/seccomp-bpf")
file(MAKE_DIRECTORY "${_sandstorm_seccomp_dir}")

set(_constants_header "${_sandstorm_seccomp_dir}/constants.h")
add_custom_command(
  OUTPUT "${_constants_header}"
  COMMAND "${CMAKE_COMMAND}"
    "-DPROGRAM=$<TARGET_FILE:sandstorm_seccomp_constants>"
    "-DOUTPUT_FILE=${_constants_header}"
    -P "${PROJECT_SOURCE_DIR}/cmake/RunToFile.cmake"
  DEPENDS sandstorm_seccomp_constants
  COMMENT "Generating seccomp constants"
  VERBATIM)

set(_preprocessed_assembly "${_sandstorm_seccomp_dir}/filter.s")
add_custom_command(
  OUTPUT "${_preprocessed_assembly}"
  COMMAND "${CMAKE_C_COMPILER}" -E -x c
    -I "${PROJECT_SOURCE_DIR}/src"
    -I "${CMAKE_BINARY_DIR}/generated"
    "${PROJECT_SOURCE_DIR}/src/sandstorm/seccomp-bpf/filter.s"
    -o "${_preprocessed_assembly}"
  DEPENDS
    "${PROJECT_SOURCE_DIR}/src/sandstorm/seccomp-bpf/filter.s"
    "${_constants_header}"
  COMMENT "Preprocessing seccomp BPF assembly"
  VERBATIM)

set(_filter_header "${_sandstorm_seccomp_dir}/filter.h")
add_custom_command(
  OUTPUT "${_filter_header}"
  COMMAND "${CMAKE_COMMAND}"
    "-DBPF_ASM=$<TARGET_FILE:bpf_asm>"
    "-DINPUT_FILE=${_preprocessed_assembly}"
    "-DOUTPUT_FILE=${_filter_header}"
    -P "${PROJECT_SOURCE_DIR}/cmake/GenerateBpfHeader.cmake"
  DEPENDS bpf_asm "${_preprocessed_assembly}"
  COMMENT "Assembling seccomp BPF filter"
  VERBATIM)

add_custom_target(sandstorm_seccomp_filter DEPENDS "${_filter_header}")
set(SANDSTORM_BPF_FILTER_HEADER "${_filter_header}" PARENT_SCOPE)
