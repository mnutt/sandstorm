function(sandstorm_generate_capnp output_sources output_headers)
  set(_source_root "${PROJECT_SOURCE_DIR}/src")
  set(_output_root "${CMAKE_BINARY_DIR}/generated")
  file(MAKE_DIRECTORY "${_output_root}")

  set(_sources)
  set(_headers)
  foreach(_schema IN LISTS ARGN)
    set(_schema_source_root "${_source_root}")
    set(_capnp_source_root "${PROJECT_SOURCE_DIR}/deps/capnproto/c++/src")
    string(FIND "${_schema}" "${_capnp_source_root}/" _capnp_prefix_index)
    if(_capnp_prefix_index EQUAL 0)
      set(_schema_source_root "${_capnp_source_root}")
    endif()
    file(RELATIVE_PATH _relative_schema "${_schema_source_root}" "${_schema}")
    set(_output_base "${_output_root}/${_relative_schema}")
    get_filename_component(_output_dir "${_output_base}" DIRECTORY)
    file(MAKE_DIRECTORY "${_output_dir}")

    set(_source "${_output_base}.c++")
    set(_header "${_output_base}.h")
    add_custom_command(
      OUTPUT "${_source}" "${_header}"
      COMMAND $<TARGET_FILE:capnp_tool> compile
        -o "$<TARGET_FILE:capnpc_cpp>:${_output_root}"
        --src-prefix "${_schema_source_root}"
        -I "${_source_root}"
        -I "${PROJECT_SOURCE_DIR}/deps/capnproto/c++/src"
        "${_schema}"
      DEPENDS "${_schema}" ${ARGN} capnp_tool capnpc_cpp
      COMMENT "Compiling Cap'n Proto schema ${_relative_schema}"
      VERBATIM)
    list(APPEND _sources "${_source}")
    list(APPEND _headers "${_header}")
  endforeach()

  set_source_files_properties(${_sources} ${_headers} PROPERTIES GENERATED TRUE)
  set(${output_sources} "${_sources}" PARENT_SCOPE)
  set(${output_headers} "${_headers}" PARENT_SCOPE)
endfunction()
