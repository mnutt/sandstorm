if(NOT DEFINED URL OR NOT DEFINED OUTPUT OR NOT DEFINED SHA256)
  message(FATAL_ERROR "DownloadVerified.cmake requires URL, OUTPUT, and SHA256")
endif()

get_filename_component(_output_dir "${OUTPUT}" DIRECTORY)
file(MAKE_DIRECTORY "${_output_dir}")
file(DOWNLOAD "${URL}" "${OUTPUT}.download"
  EXPECTED_HASH "SHA256=${SHA256}"
  TLS_VERIFY ON
  STATUS _status)
list(GET _status 0 _code)
list(GET _status 1 _message)
if(NOT _code EQUAL 0)
  file(REMOVE "${OUTPUT}.download")
  message(FATAL_ERROR "Download failed: ${_message}")
endif()
file(RENAME "${OUTPUT}.download" "${OUTPUT}")
file(CHMOD "${OUTPUT}" PERMISSIONS
  OWNER_READ OWNER_WRITE OWNER_EXECUTE GROUP_READ GROUP_EXECUTE WORLD_READ WORLD_EXECUTE)
