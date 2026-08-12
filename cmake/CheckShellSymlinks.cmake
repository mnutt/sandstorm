if(NOT DEFINED FIND OR NOT DEFINED SHELL_DIR)
  message(FATAL_ERROR "FIND and SHELL_DIR are required")
endif()

execute_process(
  COMMAND "${FIND}" -L "${SHELL_DIR}"
    "(" -path "${SHELL_DIR}/.meteor" -o -path "${SHELL_DIR}/node_modules" ")"
    -prune -o -type l -print
  OUTPUT_VARIABLE broken_links
  RESULT_VARIABLE result)
if(NOT result EQUAL 0)
  message(FATAL_ERROR "find failed with exit status ${result}")
endif()
if(broken_links)
  string(STRIP "${broken_links}" broken_links)
  message(FATAL_ERROR "Broken symlinks in shell:\n${broken_links}")
endif()
