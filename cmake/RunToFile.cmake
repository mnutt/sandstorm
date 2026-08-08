if(NOT DEFINED PROGRAM OR NOT DEFINED OUTPUT_FILE)
  message(FATAL_ERROR "PROGRAM and OUTPUT_FILE are required")
endif()

execute_process(
  COMMAND "${PROGRAM}"
  OUTPUT_FILE "${OUTPUT_FILE}"
  RESULT_VARIABLE result)
if(NOT result EQUAL 0)
  file(REMOVE "${OUTPUT_FILE}")
  message(FATAL_ERROR "${PROGRAM} failed with exit status ${result}")
endif()

