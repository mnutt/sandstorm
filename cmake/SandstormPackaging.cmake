function(sandstorm_add_packaging_targets)
  set(SANDSTORM_APP_INDEX_KEYRING "$ENV{HOME}/.sandstorm-keyring" CACHE FILEPATH
    "Keyring containing the app-index package signing key")
  set(_package_dir "${CMAKE_BINARY_DIR}/packages")
  set(_spk_stage "${_package_dir}/spk-stage")
  file(MAKE_DIRECTORY "${_package_dir}")

  set(_test_app_source "${PROJECT_SOURCE_DIR}/src/sandstorm/test-app")
  set(_test_app_stage "${_spk_stage}/sandstorm/test-app")
  set(_test_app_stage_stamp "${_package_dir}/test-app-stage.stamp")
  set(_test_app_html
    "${_test_app_source}/test-app.html"
    "${_test_app_source}/test-powerbox.html"
    "${_test_app_source}/shutdown.html"
    "${_test_app_source}/static-index.html")
  add_custom_command(
    OUTPUT "${_test_app_stage_stamp}"
    COMMAND "${CMAKE_COMMAND}" -E make_directory "${_test_app_stage}"
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different
      "$<TARGET_FILE:test-app>"
      "${_test_app_source}/test-app.capnp"
      ${_test_app_html}
      "${_test_app_stage}"
    COMMAND "${CMAKE_COMMAND}" -E touch "${_test_app_stage_stamp}"
    DEPENDS
      test-app
      "${_test_app_source}/test-app.capnp"
      ${_test_app_html}
    COMMENT "Staging the Sandstorm test app package"
    VERBATIM)

  set(_test_app_spk "${_package_dir}/test-app.spk")
  add_custom_command(
    OUTPUT "${_test_app_spk}"
    COMMAND "$<TARGET_FILE:spk>" pack
      -k "${_test_app_source}/test-app.key"
      -I "${PROJECT_SOURCE_DIR}/src"
      -I "${_spk_stage}"
      -p "${_test_app_stage}/test-app.capnp:pkgdef"
      "${_test_app_spk}"
    WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}"
    DEPENDS spk "${_test_app_stage_stamp}" "${_test_app_source}/test-app.key"
    COMMENT "Packing test-app.spk"
    VERBATIM)
  add_custom_target(test-app-spk DEPENDS "${_test_app_spk}")

  add_custom_target(test-app-dev
    COMMAND "$<TARGET_FILE:spk>" dev
      -I "${PROJECT_SOURCE_DIR}/src"
      -I "${_spk_stage}"
      -p "${_test_app_stage}/test-app.capnp:pkgdef"
    DEPENDS spk "${_test_app_stage_stamp}"
    WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}"
    USES_TERMINAL
    COMMENT "Running the Sandstorm test app in development mode"
    VERBATIM)

  set(_app_index_source "${PROJECT_SOURCE_DIR}/src/sandstorm/app-index")
  set(_app_index_stage "${_spk_stage}/sandstorm/app-index")
  set(_app_index_stage_stamp "${_package_dir}/app-index-stage.stamp")
  add_custom_command(
    OUTPUT "${_app_index_stage_stamp}"
    COMMAND "${CMAKE_COMMAND}" -E make_directory "${_app_index_stage}"
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different
      "$<TARGET_FILE:app-index>"
      "${_app_index_source}/app-index.capnp"
      "${_app_index_source}/review.html"
      "${_app_index_stage}"
    COMMAND "${CMAKE_COMMAND}" -E touch "${_app_index_stage_stamp}"
    DEPENDS
      app-index
      "${_app_index_source}/app-index.capnp"
      "${_app_index_source}/review.html"
    COMMENT "Staging the Sandstorm app index package"
    VERBATIM)

  set(_app_index_spk "${_package_dir}/app-index.spk")
  add_custom_command(
    OUTPUT "${_app_index_spk}"
    COMMAND "$<TARGET_FILE:spk>" pack
      -k "${SANDSTORM_APP_INDEX_KEYRING}"
      -I "${PROJECT_SOURCE_DIR}/src"
      -I "${_spk_stage}"
      -p "${_app_index_stage}/app-index.capnp:pkgdef"
      "${_app_index_spk}"
    WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}"
    DEPENDS
      spk
      "${_app_index_stage_stamp}"
      "${PROJECT_SOURCE_DIR}/app-index-sandstorm-files.list"
    COMMENT "Packing app-index.spk"
    VERBATIM)
  add_custom_target(app-index-spk DEPENDS "${_app_index_spk}")

  add_custom_target(app-index-dev
    COMMAND "$<TARGET_FILE:spk>" dev
      -I "${PROJECT_SOURCE_DIR}/src"
      -I "${_spk_stage}"
      -p "${_app_index_stage}/app-index.capnp:pkgdef"
    DEPENDS spk "${_app_index_stage_stamp}"
    WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}"
    USES_TERMINAL
    COMMENT "Running the Sandstorm app index in development mode"
    VERBATIM)

  if(NOT SANDSTORM_BUILD_FRONTEND OR NOT TARGET shell-build)
    return()
  endif()

  set(_meteor_testapp_source "${PROJECT_SOURCE_DIR}/meteor-testapp")
  set(_meteor_testapp_root "${_package_dir}/meteor-testapp-root")
  set(_meteor_testapp_work "${_meteor_testapp_root}/app")
  set(_meteor_testapp_stage "${_meteor_testapp_work}/.meteor-spk")
  set(_meteor_testapp_stage_stamp "${_package_dir}/meteor-testapp-stage.stamp")
  file(GLOB_RECURSE _meteor_testapp_sources CONFIGURE_DEPENDS
    "${_meteor_testapp_source}/client/*"
    "${_meteor_testapp_source}/server/*"
    "${_meteor_testapp_source}/scripts/*"
    "${PROJECT_SOURCE_DIR}/shell/packages/accounts-sandstorm/*")
  list(APPEND _meteor_testapp_sources
    "${_meteor_testapp_source}/.meteor/packages"
    "${_meteor_testapp_source}/.meteor/platforms"
    "${_meteor_testapp_source}/.meteor/release"
    "${_meteor_testapp_source}/.meteor/versions")
  list(FILTER _meteor_testapp_sources EXCLUDE REGEX
    "/(node_modules|\.meteor/local|_build|build-assets|build-chunks)/")
  add_custom_command(
    OUTPUT "${_meteor_testapp_stage_stamp}"
    COMMAND "${CMAKE_COMMAND}" -E make_directory "${_meteor_testapp_work}"
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different
      "${_meteor_testapp_source}/sandstorm-pkgdef.capnp"
      "${_meteor_testapp_work}/sandstorm-pkgdef.capnp"
    COMMAND "${CMAKE_COMMAND}" -E create_symlink
      "${PROJECT_SOURCE_DIR}/src" "${_meteor_testapp_root}/src"
    COMMAND "${CMAKE_COMMAND}" -E env
      "SANDSTORM_METEOR_TESTAPP_STAGE_DIR=${_meteor_testapp_stage}"
      --modify "PATH=path_list_prepend:${SANDSTORM_METEOR_DEV_BUNDLE}/bin" --
      "${_meteor_testapp_source}/scripts/stage-runtime.sh"
    COMMAND "${CMAKE_COMMAND}" -E touch "${_meteor_testapp_stage_stamp}"
    DEPENDS
      "${_meteor_testapp_source}/package.json"
      "${_meteor_testapp_source}/package-lock.json"
      "${_meteor_testapp_source}/sandstorm-pkgdef.capnp"
      ${_meteor_testapp_sources}
    COMMENT "Staging the Meteor system-test application"
    VERBATIM)
  add_custom_target(meteor-testapp-stage DEPENDS "${_meteor_testapp_stage_stamp}")

  set(_meteor_testapp_spk "${_package_dir}/meteor-testapp.spk")
  add_custom_command(
    OUTPUT "${_meteor_testapp_spk}"
    COMMAND "$<TARGET_FILE:spk>" pack
      -k "${_meteor_testapp_source}/meteor-testapp.key"
      -I "${PROJECT_SOURCE_DIR}/src"
      "${_meteor_testapp_spk}"
    WORKING_DIRECTORY "${_meteor_testapp_work}"
    DEPENDS
      spk
      sandstorm-http-bridge
      "${_meteor_testapp_stage_stamp}"
      "${_meteor_testapp_source}/meteor-testapp.key"
    COMMENT "Packing meteor-testapp.spk"
    VERBATIM)
  add_custom_target(meteor-testapp-spk DEPENDS "${_meteor_testapp_spk}")

  add_custom_target(meteor-testapp-dev
    COMMAND "$<TARGET_FILE:spk>" dev
      -I "${PROJECT_SOURCE_DIR}/src"
      -I "${_spk_stage}"
      -s /opt/sandstorm
    DEPENDS spk "${_meteor_testapp_stage_stamp}"
    WORKING_DIRECTORY "${_meteor_testapp_work}"
    USES_TERMINAL
    COMMENT "Running the Meteor test application in development mode"
    VERBATIM)

  find_program(SANDSTORM_TAR_EXECUTABLE NAMES tar REQUIRED)
  find_program(SANDSTORM_XZ_EXECUTABLE NAMES xz REQUIRED)

  set(_bundle_dir "${CMAKE_BINARY_DIR}/bundle")
  set(_bundle_stamp "${CMAKE_BINARY_DIR}/bundle.stamp")
  file(GLOB _bundle_capnp_schemas CONFIGURE_DEPENDS
    "${PROJECT_SOURCE_DIR}/src/capnp/*.capnp"
    "${PROJECT_SOURCE_DIR}/src/sandstorm/*.capnp")
  add_custom_command(
    OUTPUT "${_bundle_stamp}"
    COMMAND "${CMAKE_COMMAND}" -E env
      "CC=${CMAKE_C_COMPILER}"
      "SANDSTORM_SOURCE_ROOT=${PROJECT_SOURCE_DIR}"
      "SANDSTORM_NATIVE_STAGE=${CMAKE_BINARY_DIR}/stage"
      "SANDSTORM_SHELL_BUILD_DIR=${CMAKE_BINARY_DIR}/shell-build"
      "SANDSTORM_BUNDLE_DIR=${_bundle_dir}"
      "SANDSTORM_WORK_DIR=${CMAKE_BINARY_DIR}/bundle-work"
      "${PROJECT_SOURCE_DIR}/make-bundle.sh"
    COMMAND "${CMAKE_COMMAND}" -E touch "${_bundle_stamp}"
    WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}"
    DEPENDS
      "${SANDSTORM_SHELL_BUILD_STAMP}"
      "${SANDSTORM_NATIVE_STAGE_STAMP}"
      "${PROJECT_SOURCE_DIR}/make-bundle.sh"
      "${PROJECT_SOURCE_DIR}/find-meteor-dev-bundle.sh"
      "${PROJECT_SOURCE_DIR}/localedata-C"
      "${PROJECT_SOURCE_DIR}/meteor-bundle-main.js"
      ${_bundle_capnp_schemas}
    COMMENT "Assembling the Sandstorm bundle"
    VERBATIM)
  add_custom_target(bundle DEPENDS "${_bundle_stamp}")

  function(_sandstorm_add_tarball target suffix fast)
    set(_output "${_package_dir}/sandstorm-${SANDSTORM_BUILD}${suffix}.tar.xz")
    add_custom_command(
      OUTPUT "${_output}"
      COMMAND "${CMAKE_COMMAND}"
        "-DBUNDLE_DIR=${_bundle_dir}"
        "-DOUTPUT_FILE=${_output}"
        "-DBUILD_NUMBER=${SANDSTORM_BUILD}"
        "-DTAR=${SANDSTORM_TAR_EXECUTABLE}"
        "-DXZ=${SANDSTORM_XZ_EXECUTABLE}"
        "-DFAST=${fast}"
        -P "${PROJECT_SOURCE_DIR}/cmake/CreateTarball.cmake"
      DEPENDS "${_bundle_stamp}" "${PROJECT_SOURCE_DIR}/cmake/CreateTarball.cmake"
      COMMENT "Creating ${_output}"
      VERBATIM)
    add_custom_target("${target}" DEPENDS "${_output}")
  endfunction()

  _sandstorm_add_tarball(package "" FALSE)
  _sandstorm_add_tarball(package-fast "-fast" TRUE)

  set(_fast_package
    "${_package_dir}/sandstorm-${SANDSTORM_BUILD}-fast.tar.xz")
  add_custom_target(install-local
    COMMAND "${PROJECT_SOURCE_DIR}/install.sh" "${_fast_package}"
    DEPENDS package-fast
    WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}"
    USES_TERMINAL
    COMMENT "Installing the locally-built Sandstorm package"
    VERBATIM)

  add_custom_target(update-local
    COMMAND sudo sandstorm update "${_fast_package}"
    DEPENDS package-fast
    WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}"
    USES_TERMINAL
    COMMENT "Updating the local Sandstorm installation"
    VERBATIM)

  add_custom_target(system-test
    COMMAND "${CMAKE_COMMAND}" -E env
      "SANDSTORM_METEOR_TESTAPP_PATH=${_meteor_testapp_spk}"
      "${PROJECT_SOURCE_DIR}/tests/run-local.sh"
      "${_package_dir}/sandstorm-${SANDSTORM_BUILD}-fast.tar.xz"
      "${_test_app_spk}"
    DEPENDS package-fast test-app-spk meteor-testapp-spk
    WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}"
    USES_TERMINAL
    COMMENT "Running Sandstorm system tests"
    VERBATIM)
endfunction()
