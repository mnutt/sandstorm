if(NOT DEFINED MARKDOWN OR NOT DEFINED INPUT_FILE OR NOT DEFINED OUTPUT_FILE)
  message(FATAL_ERROR "MARKDOWN, INPUT_FILE, and OUTPUT_FILE are required")
endif()

execute_process(
  COMMAND "${MARKDOWN}" "${INPUT_FILE}"
  OUTPUT_VARIABLE rendered
  RESULT_VARIABLE result)
if(NOT result EQUAL 0)
  file(REMOVE "${OUTPUT_FILE}")
  message(FATAL_ERROR "markdown failed with exit status ${result}")
endif()

file(WRITE "${OUTPUT_FILE}"
  "<template name=\"changelog\">\n${rendered}</template>\n")
