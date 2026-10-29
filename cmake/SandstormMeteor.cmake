function(sandstorm_resolve_meteor_toolchain)
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    "${PROJECT_SOURCE_DIR}/shell/.meteor/release")
  set(SANDSTORM_METEOR_DEV_BUNDLE "${SANDSTORM_METEOR_DEV_BUNDLE}" CACHE PATH
    "Meteor dev bundle used for frontend and schema compilation")

  # Refresh automatically discovered bundles when the pinned Meteor release
  # changes, while preserving an explicit dev-bundle override.
  if(NOT SANDSTORM_METEOR_DEV_BUNDLE OR
      SANDSTORM_METEOR_DEV_BUNDLE STREQUAL "${SANDSTORM_AUTO_METEOR_DEV_BUNDLE}")
    execute_process(
      COMMAND "${PROJECT_SOURCE_DIR}/find-meteor-dev-bundle.sh"
      WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}"
      OUTPUT_VARIABLE _meteor_dev_bundle
      OUTPUT_STRIP_TRAILING_WHITESPACE
      RESULT_VARIABLE _meteor_result)
    if(NOT _meteor_result EQUAL 0 OR NOT _meteor_dev_bundle)
      message(FATAL_ERROR
        "Could not locate the pinned Meteor dev bundle. Install the pinned "
        "Meteor release or set SANDSTORM_METEOR_DEV_BUNDLE explicitly.")
    endif()
    set(SANDSTORM_METEOR_DEV_BUNDLE "${_meteor_dev_bundle}" CACHE PATH
      "Meteor dev bundle used for frontend and schema compilation" FORCE)
    set(SANDSTORM_AUTO_METEOR_DEV_BUNDLE "${_meteor_dev_bundle}" CACHE INTERNAL
      "Last automatically resolved Meteor dev bundle" FORCE)
  endif()

  foreach(_tool node npm)
    if(NOT EXISTS "${SANDSTORM_METEOR_DEV_BUNDLE}/bin/${_tool}")
      message(FATAL_ERROR
        "${_tool} not found in Meteor dev bundle: ${SANDSTORM_METEOR_DEV_BUNDLE}")
    endif()
  endforeach()
endfunction()
