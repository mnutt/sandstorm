if(NOT DEFINED COMMAND OR NOT DEFINED EXPECTED)
  message(FATAL_ERROR "VerifyCommandOutput.cmake requires COMMAND and EXPECTED")
endif()

execute_process(
  COMMAND "${COMMAND}" ${ARGUMENTS}
  RESULT_VARIABLE _status
  OUTPUT_VARIABLE _output
  ERROR_VARIABLE _error
  OUTPUT_STRIP_TRAILING_WHITESPACE)
if(NOT _status EQUAL 0)
  message(FATAL_ERROR "${COMMAND} failed (${_status}): ${_error}")
endif()
if(NOT _output STREQUAL EXPECTED)
  message(FATAL_ERROR "Expected '${EXPECTED}', got '${_output}'")
endif()
