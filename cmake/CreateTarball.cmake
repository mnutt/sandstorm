if(NOT DEFINED BUNDLE_DIR OR NOT DEFINED OUTPUT_FILE OR NOT DEFINED BUILD_NUMBER
    OR NOT DEFINED TAR OR NOT DEFINED XZ)
  message(FATAL_ERROR
    "BUNDLE_DIR, OUTPUT_FILE, BUILD_NUMBER, TAR, and XZ are required")
endif()

get_filename_component(bundle_parent "${BUNDLE_DIR}" DIRECTORY)
get_filename_component(bundle_name "${BUNDLE_DIR}" NAME)
set(xz_options -c)
if(FAST)
  list(APPEND xz_options -0 --threads=0)
else()
  list(APPEND xz_options -9e)
endif()

execute_process(
  COMMAND "${TAR}" c
    "--transform=s,^${bundle_name},sandstorm-${BUILD_NUMBER},"
    "${bundle_name}"
  COMMAND "${XZ}" ${xz_options}
  WORKING_DIRECTORY "${bundle_parent}"
  OUTPUT_FILE "${OUTPUT_FILE}"
  RESULT_VARIABLE result)
if(NOT result EQUAL 0)
  file(REMOVE "${OUTPUT_FILE}")
  message(FATAL_ERROR "Creating ${OUTPUT_FILE} failed with exit status ${result}")
endif()
