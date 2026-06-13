if(NOT DEFINED INPUT OR NOT DEFINED OUTPUT OR NOT DEFINED VARIABLE)
  message(FATAL_ERROR "EmbedJs.cmake requires INPUT, OUTPUT, and VARIABLE")
endif()

file(READ "${INPUT}" _source HEX)
string(REGEX REPLACE "(..)" "\\\\x\\1" _escaped "${_source}")
get_filename_component(_output_dir "${OUTPUT}" DIRECTORY)
file(MAKE_DIRECTORY "${_output_dir}")
file(WRITE "${OUTPUT}"
  "// Generated from ${INPUT}. Do not edit.\n"
  "#pragma once\n\n"
  "namespace sandstorm {\n"
  "static constexpr const char ${VARIABLE}[] = \"${_escaped}\";\n"
  "}  // namespace sandstorm\n")
