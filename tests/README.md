# Sandstorm Tests

## Setup

From the tests directory, run `npm install` to install the Node dependencies. The test runner uses
the packaged ChromeDriver and downloads its matching Chrome-for-Testing release under
`tests/.browsers`; Java, Selenium Server, and a system browser are not required.

## Run Tests -- The easy way

In the parent directory, run:

    cmake --preset dev
    cmake --build --preset dev --target system-test

## Run Tests -- Manual

Run the tests with `npm test`. This requires a running instance of sandstorm, and **WILL**
potentially change the database. If you aren't comfortable with that, use the `run-local.sh`
script. It takes a bundle and test application package as arguments. For example, after building
the CMake packaging targets, run:

    cmake --build --preset dev --target package-fast test-app-spk meteor-testapp-spk
    SANDSTORM_METEOR_TESTAPP_PATH=build/dev/packages/meteor-testapp.spk \
      tests/run-local.sh build/dev/packages/sandstorm-0-fast.tar.xz \
        build/dev/packages/test-app.spk

## Running just one test case

Say you want to run the test defined in `tests/grain.js` whose name is
"Test grain anonymous user". You can do so like so:

    TESTCASE="tests/grain.js Test grain anonymous user" \
        cmake --build --preset dev --target system-test

The name must match exactly.

You can also run all test cases in a file:

    TESTCASE="tests/grain.js" cmake --build --preset dev --target system-test

## Running isolate example browser tests

The isolate Powerbox examples have a focused target:

    cmake --build --preset dev --target isolate-examples-test

This builds the isolate example apps and runs `tests/apps/isolate-examples.js`
against a local Sandstorm instance. The test file covers browser-mediated
Powerbox selection, saved provider tokens, native `capnp:` browser helpers,
durable capability tokens, and returned child/session capabilities.

When running `tests/apps/isolate-examples.js` directly, set
`ISOLATE_API_POWERBOX_TEST_SPK` or `ISOLATE_API_PROVIDER_TEST_SPK` to use
prebuilt example packages outside `tests/assets/`.

## Displaying the browser's UI during tests

By default the tests run against a mock X server, so the browser windows
are not displayed. However, it can be helpful to display the browser
windows when debugging. You can do this by setting `SHOW_BROWSER=true`:

    SHOW_BROWSER=true cmake --build --preset dev --target system-test

## Dealing with tests which are expected to fail

Some tests are known to fail, either always or intermittently. Obviously
we should fix these, but so that the full test suite can remain useful
in the interim, we disable these tests by default; if you want to run
them you can set `RUN_XFAIL=true`:

    RUN_XFAIL=true cmake --build --preset dev --target system-test

When writing tests, this variable is exposed as `run_xfail` in
`tests/util.js`; you can disable a test by simply wrapping it in an
if statement:

```js
if (utils.run_xfail) {
  module.exports["Test something broken"] = function (browser) {
    // ...
  };
}
```

If you need to disable a test, please make sure to open an issue for it,
and link to the issue from a comment.

## How to dump the DOM for debugging

Stick this in the test:

    browser.execute(function () {
      return document.body.innerHTML;
    }, [], function (result) {
      console.log(result);
    });

(There's probably an easier way...)
