function(sandstorm_add_node_capnp)
  set(SANDSTORM_METEOR_DEV_BUNDLE "${SANDSTORM_METEOR_DEV_BUNDLE}" CACHE PATH
    "Meteor dev bundle used to build capnp.node")
  set(SANDSTORM_NODE_EXECUTABLE "${SANDSTORM_NODE_EXECUTABLE}" CACHE FILEPATH
    "Node executable used to test capnp.node")
  set(SANDSTORM_NODE_INCLUDE_DIR "${SANDSTORM_NODE_INCLUDE_DIR}" CACHE PATH
    "Directory containing Node headers")

  if(NOT SANDSTORM_NODE_EXECUTABLE OR NOT SANDSTORM_NODE_INCLUDE_DIR)
    if(NOT SANDSTORM_METEOR_DEV_BUNDLE)
      execute_process(
        COMMAND "${PROJECT_SOURCE_DIR}/find-meteor-dev-bundle.sh"
        WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}"
        OUTPUT_VARIABLE _meteor_dev_bundle
        OUTPUT_STRIP_TRAILING_WHITESPACE
        RESULT_VARIABLE _meteor_result)
      if(NOT _meteor_result EQUAL 0 OR NOT _meteor_dev_bundle)
        message(FATAL_ERROR
          "Could not locate the Meteor dev bundle for capnp.node. Set "
          "SANDSTORM_NODE_EXECUTABLE and SANDSTORM_NODE_INCLUDE_DIR to "
          "use a custom Node installation.")
      endif()
      set(SANDSTORM_METEOR_DEV_BUNDLE "${_meteor_dev_bundle}" CACHE PATH
        "Meteor dev bundle used to build capnp.node" FORCE)
    endif()

    if(NOT SANDSTORM_NODE_EXECUTABLE)
      set(SANDSTORM_NODE_EXECUTABLE
        "${SANDSTORM_METEOR_DEV_BUNDLE}/bin/node" CACHE FILEPATH
        "Node executable used to test capnp.node" FORCE)
    endif()
    if(NOT SANDSTORM_NODE_INCLUDE_DIR)
      set(SANDSTORM_NODE_INCLUDE_DIR
        "${SANDSTORM_METEOR_DEV_BUNDLE}/include/node" CACHE PATH
        "Directory containing Node headers" FORCE)
    endif()
  endif()

  if(NOT EXISTS "${SANDSTORM_NODE_EXECUTABLE}")
    message(FATAL_ERROR
      "Node executable not found at ${SANDSTORM_NODE_EXECUTABLE}")
  endif()
  if(NOT EXISTS "${SANDSTORM_NODE_INCLUDE_DIR}/node.h")
    message(FATAL_ERROR
      "Node headers not found in ${SANDSTORM_NODE_INCLUDE_DIR}")
  endif()

  add_library(node_capnp MODULE
    "${PROJECT_SOURCE_DIR}/deps/node-capnp/src/node-capnp/capnp.cc")
  set_target_properties(node_capnp PROPERTIES
    OUTPUT_NAME capnp
    PREFIX ""
    SUFFIX ".node")
  target_include_directories(node_capnp PRIVATE
    "${SANDSTORM_NODE_INCLUDE_DIR}")
  # node-capnp's frozen Node 14 branch uses legacy Cap'n Proto and Node APIs.
  target_compile_options(node_capnp PRIVATE -Wno-deprecated-declarations)
  target_link_libraries(node_capnp PRIVATE
    sandstorm_build_options
    CapnProto::capnp-rpc
    capnpc
    sodium
    ZLIB::ZLIB)

  if(BUILD_TESTING)
    set(_node_test_dir "${CMAKE_BINARY_DIR}/node-capnp")
    set_target_properties(node_capnp PROPERTIES
      LIBRARY_OUTPUT_DIRECTORY "${_node_test_dir}")

    set(_node_capnp_source_dir
      "${PROJECT_SOURCE_DIR}/deps/node-capnp/src/node-capnp")
    set(_node_test_data
      binary
      flat
      packedbinary
      packedflat)
    list(TRANSFORM _node_test_data
      PREPEND "${_node_capnp_source_dir}/testdata/")
    set(_node_test_stamp "${_node_test_dir}/stage.stamp")
    add_custom_command(
      OUTPUT "${_node_test_stamp}"
      COMMAND "${CMAKE_COMMAND}" -E make_directory "${_node_test_dir}"
      COMMAND "${CMAKE_COMMAND}" -E copy_if_different
        "${_node_capnp_source_dir}/capnp.js"
        "${_node_capnp_source_dir}/capnp-test.js"
        "${_node_capnp_source_dir}/test.capnp"
        "${_node_test_dir}"
      COMMAND "${CMAKE_COMMAND}" -E copy_directory
        "${_node_capnp_source_dir}/testdata"
        "${_node_test_dir}/node-capnp/testdata"
      COMMAND "${CMAKE_COMMAND}" -E touch "${_node_test_stamp}"
      DEPENDS
        node_capnp
        "${_node_capnp_source_dir}/capnp.js"
        "${_node_capnp_source_dir}/capnp-test.js"
        "${_node_capnp_source_dir}/test.capnp"
        ${_node_test_data}
      COMMENT "Staging node-capnp tests"
      VERBATIM)
    add_custom_target(node_capnp_test_stage ALL DEPENDS "${_node_test_stamp}")

    add_test(NAME node-capnp
      COMMAND "${SANDSTORM_NODE_EXECUTABLE}" capnp-test.js)
    set_tests_properties(node-capnp PROPERTIES
      WORKING_DIRECTORY "${_node_test_dir}"
      ENVIRONMENT "NODE_PATH=${PROJECT_SOURCE_DIR}/src")
  endif()
endfunction()
