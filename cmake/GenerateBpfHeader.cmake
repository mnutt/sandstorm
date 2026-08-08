if(NOT DEFINED BPF_ASM OR NOT DEFINED INPUT_FILE OR NOT DEFINED OUTPUT_FILE)
  message(FATAL_ERROR "BPF_ASM, INPUT_FILE, and OUTPUT_FILE are required")
endif()

execute_process(
  COMMAND "${BPF_ASM}" -c "${INPUT_FILE}"
  OUTPUT_FILE "${OUTPUT_FILE}"
  RESULT_VARIABLE result)
if(NOT result EQUAL 0)
  file(REMOVE "${OUTPUT_FILE}")
  message(FATAL_ERROR "bpf_asm failed with exit status ${result}")
endif()

