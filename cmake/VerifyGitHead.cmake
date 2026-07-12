if(NOT DEFINED GIT OR NOT DEFINED REPOSITORY OR NOT DEFINED EXPECTED)
  message(FATAL_ERROR "VerifyGitHead.cmake requires GIT, REPOSITORY, and EXPECTED")
endif()

execute_process(
  COMMAND "${GIT}" -C "${REPOSITORY}" rev-parse HEAD
  RESULT_VARIABLE _status
  OUTPUT_VARIABLE _head
  ERROR_VARIABLE _error
  OUTPUT_STRIP_TRAILING_WHITESPACE)
if(NOT _status EQUAL 0)
  message(FATAL_ERROR "Could not inspect ${REPOSITORY}: ${_error}")
endif()
if(NOT _head STREQUAL EXPECTED)
  message(FATAL_ERROR "Expected workerd ${EXPECTED}, got ${_head}")
endif()
