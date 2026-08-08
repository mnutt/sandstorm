if(NOT DEFINED INPUT_FILE OR NOT DEFINED OUTPUT_FILE OR NOT DEFINED COLOR)
  message(FATAL_ERROR "INPUT_FILE, OUTPUT_FILE, and COLOR are required")
endif()

file(READ "${INPUT_FILE}" contents)
string(REPLACE "#111111" "#${COLOR}" contents "${contents}")
file(WRITE "${OUTPUT_FILE}" "${contents}")
