function(sandstorm_add_frontend_targets)
  if(NOT SANDSTORM_BUILD_FRONTEND)
    return()
  endif()
  if(NOT SANDSTORM_BUILD_NODE_CAPNP)
    message(STATUS "Frontend targets disabled because SANDSTORM_BUILD_NODE_CAPNP is OFF")
    return()
  endif()

  find_program(SANDSTORM_MARKDOWN_EXECUTABLE NAMES markdown REQUIRED)
  find_program(SANDSTORM_FIND_EXECUTABLE NAMES find REQUIRED)
  find_program(SANDSTORM_METEOR_EXECUTABLE NAMES meteor REQUIRED)

  set(_meteor_bin "${SANDSTORM_METEOR_DEV_BUNDLE}/bin")
  set(_npm "${_meteor_bin}/npm")
  set(_frontend_dir "${CMAKE_BINARY_DIR}/frontend")
  set(_shell_build_dir "${CMAKE_BINARY_DIR}/shell-build")
  file(MAKE_DIRECTORY "${_frontend_dir}")

  file(GLOB _icon_sources CONFIGURE_DEPENDS
    "${PROJECT_SOURCE_DIR}/icons/*.svg")
  set(_icons_npm_stamp "${_frontend_dir}/icons-npm.stamp")
  add_custom_command(
    OUTPUT "${_icons_npm_stamp}"
    COMMAND "${CMAKE_COMMAND}" -E env "PATH=${_meteor_bin}:$ENV{PATH}"
      "${_npm}" install --no-fund
    COMMAND "${CMAKE_COMMAND}" -E touch "${_icons_npm_stamp}"
    WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}/icons"
    DEPENDS
      "${PROJECT_SOURCE_DIR}/icons/package.json"
      "${PROJECT_SOURCE_DIR}/icons/package-lock.json"
    COMMENT "Installing icon generator dependencies"
    VERBATIM)

  set(_icon_stylesheet
    "${PROJECT_SOURCE_DIR}/shell/imports/client/styles/global/_icons.scss")
  set(_icon_api_stylesheet
    "${PROJECT_SOURCE_DIR}/shell/imports/client/styles/icons/_api.scss")
  set(_icon_build_stamp "${_frontend_dir}/icons-build.stamp")
  add_custom_command(
    OUTPUT "${_icon_build_stamp}"
    BYPRODUCTS "${_icon_stylesheet}" "${_icon_api_stylesheet}"
    COMMAND "${CMAKE_COMMAND}" -E env "PATH=${_meteor_bin}:$ENV{PATH}"
      "${_npm}" run build
    COMMAND "${CMAKE_COMMAND}" -E touch "${_icon_build_stamp}"
    WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}/icons"
    DEPENDS
      "${_icons_npm_stamp}"
      "${PROJECT_SOURCE_DIR}/icons/build.js"
      "${PROJECT_SOURCE_DIR}/icons/codepoints.json"
      ${_icon_sources}
    COMMENT "Generating Sandstorm icon fonts and stylesheets"
    VERBATIM)

  set(_changelog "${PROJECT_SOURCE_DIR}/shell/imports/client/changelog.html")
  add_custom_command(
    OUTPUT "${_changelog}"
    COMMAND "${CMAKE_COMMAND}"
      "-DMARKDOWN=${SANDSTORM_MARKDOWN_EXECUTABLE}"
      "-DINPUT_FILE=${PROJECT_SOURCE_DIR}/CHANGELOG.md"
      "-DOUTPUT_FILE=${_changelog}"
      -P "${PROJECT_SOURCE_DIR}/cmake/GenerateChangelog.cmake"
    DEPENDS
      "${PROJECT_SOURCE_DIR}/CHANGELOG.md"
      "${PROJECT_SOURCE_DIR}/cmake/GenerateChangelog.cmake"
    COMMENT "Generating the shell changelog template"
    VERBATIM)

  set(_plain_icons
    apps appmarket battery bug close copy debug download down email github google
    key ldap link menu notification open-grain openid people restart restore search
    settings share source trash troubleshoot upload up web)
  set(_menu_icons
    add-credit add-email appmarket apps bug clipboard close copy credit debug download
    down email github key keybase ldap link notification open-grain people pronoun
    restart settings share source trash troubleshoot twitter unlink up web)
  set(_recolored_icons)

  function(_sandstorm_recolor_icon source_name output_name color)
    set(_output "${PROJECT_SOURCE_DIR}/shell/public/${output_name}.svg")
    add_custom_command(
      OUTPUT "${_output}"
      COMMAND "${CMAKE_COMMAND}"
        "-DINPUT_FILE=${PROJECT_SOURCE_DIR}/icons/${source_name}.svg"
        "-DOUTPUT_FILE=${_output}"
        "-DCOLOR=${color}"
        -P "${PROJECT_SOURCE_DIR}/cmake/RecolorSvg.cmake"
      DEPENDS
        "${PROJECT_SOURCE_DIR}/icons/${source_name}.svg"
        "${PROJECT_SOURCE_DIR}/cmake/RecolorSvg.cmake"
      COMMENT "Generating shell/public/${output_name}.svg"
      VERBATIM)
    set(_recolored_icons ${_recolored_icons} "${_output}" PARENT_SCOPE)
  endfunction()

  foreach(_icon IN LISTS _plain_icons)
    _sandstorm_recolor_icon("${_icon}" "${_icon}" CCCCCC)
  endforeach()
  foreach(_icon IN LISTS _menu_icons)
    _sandstorm_recolor_icon("${_icon}" "${_icon}-m" 000000)
  endforeach()
  _sandstorm_recolor_icon(google google-color a53232)
  _sandstorm_recolor_icon(github github-color 191919)
  _sandstorm_recolor_icon(email email-494949 494949)
  _sandstorm_recolor_icon(close close-FFFFFF FFFFFF)
  _sandstorm_recolor_icon(install install-714DAA 714DAA)
  _sandstorm_recolor_icon(install install-896AC6 896AC6)
  _sandstorm_recolor_icon(plus plus-6A237C 6A237C)
  _sandstorm_recolor_icon(plus plus-9E40B5 9E40B5)
  _sandstorm_recolor_icon(upload upload-B7B7B7 B7B7B7)
  _sandstorm_recolor_icon(upload upload-5D5D5D 5D5D5D)
  _sandstorm_recolor_icon(restore restore-B7B7B7 B7B7B7)
  _sandstorm_recolor_icon(restore restore-5D5D5D 5D5D5D)
  _sandstorm_recolor_icon(question question-a9a9a9 A9A9A9)
  _sandstorm_recolor_icon(question question-727272 727272)

  add_custom_target(shell-assets
    DEPENDS "${_icon_build_stamp}" "${_changelog}" ${_recolored_icons})

  set(_shell_npm_stamp "${_frontend_dir}/shell-npm.stamp")
  add_custom_command(
    OUTPUT "${_shell_npm_stamp}"
    COMMAND "${CMAKE_COMMAND}" -E env "PATH=${_meteor_bin}:$ENV{PATH}"
      "${_npm}" install --no-fund
    COMMAND "${CMAKE_COMMAND}" -E touch "${_shell_npm_stamp}"
    WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}/shell"
    DEPENDS
      "${PROJECT_SOURCE_DIR}/shell/package.json"
      "${PROJECT_SOURCE_DIR}/shell/package-lock.json"
    COMMENT "Installing Meteor shell dependencies"
    VERBATIM)

  add_custom_target(shell-env
    DEPENDS shell-assets stage-native "${_shell_npm_stamp}")

  add_custom_target(clean-frontend
    COMMAND "${CMAKE_COMMAND}" -E rm -rf
      "${_frontend_dir}"
      "${PROJECT_SOURCE_DIR}/icons/node_modules"
      "${PROJECT_SOURCE_DIR}/shell/node_modules"
      "${PROJECT_SOURCE_DIR}/shell/.meteor/local"
      "${PROJECT_SOURCE_DIR}/meteor-testapp/node_modules"
      "${CMAKE_BINARY_DIR}/packages/meteor-testapp-root"
      "${CMAKE_BINARY_DIR}/packages/meteor-testapp-stage.stamp"
      "${CMAKE_BINARY_DIR}/packages/meteor-testapp.spk"
    COMMENT "Removing frontend dependency installs and CMake stamps"
    VERBATIM)

  add_custom_target(lint
    COMMAND "${CMAKE_COMMAND}" -E env "PATH=${_meteor_bin}:$ENV{PATH}"
      "${SANDSTORM_METEOR_EXECUTABLE}" npm run lint
    DEPENDS shell-env
    WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}/shell"
    USES_TERMINAL
    COMMENT "Linting the Meteor shell"
    VERBATIM)

  add_custom_target(typecheck
    COMMAND "${CMAKE_COMMAND}" -E env "PATH=${_meteor_bin}:$ENV{PATH}"
      "${SANDSTORM_METEOR_EXECUTABLE}" npm run typecheck
    DEPENDS shell-env
    WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}/shell"
    USES_TERMINAL
    COMMENT "Type-checking the Meteor shell"
    VERBATIM)

  file(GLOB_RECURSE _shell_sources CONFIGURE_DEPENDS
    "${PROJECT_SOURCE_DIR}/shell/client/*"
    "${PROJECT_SOURCE_DIR}/shell/i18n/*"
    "${PROJECT_SOURCE_DIR}/shell/imports/*"
    "${PROJECT_SOURCE_DIR}/shell/packages/*"
    "${PROJECT_SOURCE_DIR}/shell/private/*"
    "${PROJECT_SOURCE_DIR}/shell/public/*"
    "${PROJECT_SOURCE_DIR}/shell/server/*")
  list(APPEND _shell_sources
    "${PROJECT_SOURCE_DIR}/shell/.meteor/packages"
    "${PROJECT_SOURCE_DIR}/shell/.meteor/platforms"
    "${PROJECT_SOURCE_DIR}/shell/.meteor/release"
    "${PROJECT_SOURCE_DIR}/shell/.meteor/versions")
  list(FILTER _shell_sources EXCLUDE REGEX
    "/(node_modules|\.meteor/local|_build|build-assets|build-chunks)/")

  function(_sandstorm_add_shell_build target output_dir)
    set(_stamp "${output_dir}/.cmake-built")
    set(_meteor_args build --directory "${output_dir}")
    if(ARGN)
      list(APPEND _meteor_args ${ARGN})
    endif()
    add_custom_command(
      OUTPUT "${_stamp}"
      COMMAND "${CMAKE_COMMAND}"
        "-DFIND=${SANDSTORM_FIND_EXECUTABLE}"
        "-DSHELL_DIR=${PROJECT_SOURCE_DIR}/shell"
        -P "${PROJECT_SOURCE_DIR}/cmake/CheckShellSymlinks.cmake"
      COMMAND "${CMAKE_COMMAND}" -E env
        "PATH=${_meteor_bin}:$ENV{PATH}"
        "NODE_PATH=${CMAKE_BINARY_DIR}/stage/node_modules"
        "${SANDSTORM_METEOR_EXECUTABLE}" ${_meteor_args}
      COMMAND "${CMAKE_COMMAND}" -E touch "${_stamp}"
      WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}/shell"
      DEPENDS
        shell-assets
        "${SANDSTORM_NATIVE_STAGE_STAMP}"
        "${_shell_npm_stamp}"
        "${PROJECT_SOURCE_DIR}/cmake/CheckShellSymlinks.cmake"
        ${_shell_sources}
      COMMENT "Building Meteor shell in ${output_dir}"
      VERBATIM)
    add_custom_target("${target}" DEPENDS "${_stamp}")
  endfunction()

  _sandstorm_add_shell_build(shell-build "${_shell_build_dir}")
  set(SANDSTORM_SHELL_BUILD_STAMP "${_shell_build_dir}/.cmake-built"
    CACHE INTERNAL "Stamp for the release Meteor shell build" FORCE)
  _sandstorm_add_shell_build(shell-build-debug
    "${CMAKE_BINARY_DIR}/shell-build-debug" --debug)
endfunction()
