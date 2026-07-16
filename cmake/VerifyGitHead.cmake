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

execute_process(
  COMMAND "${GIT}" -C "${REPOSITORY}" status --porcelain
  RESULT_VARIABLE _status
  OUTPUT_VARIABLE _worktree_status
  ERROR_VARIABLE _error
  OUTPUT_STRIP_TRAILING_WHITESPACE)
if(NOT _status EQUAL 0)
  message(FATAL_ERROR "Could not inspect ${REPOSITORY} status: ${_error}")
endif()
if(NOT _worktree_status STREQUAL "")
  message(FATAL_ERROR "Expected clean workerd checkout, got:\n${_worktree_status}")
endif()

if(DEFINED PATCH)
  execute_process(
    COMMAND "${GIT}" -C "${REPOSITORY}" apply --check "${PATCH}"
    RESULT_VARIABLE _status
    ERROR_VARIABLE _error)
  if(NOT _status EQUAL 0)
    message(FATAL_ERROR "Workerd patch does not apply cleanly: ${_error}")
  endif()
endif()
