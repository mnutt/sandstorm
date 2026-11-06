Title: Ensure a headless installer failure does not loop at the error-report prompt
Vagrant-Box: jessie
Precondition: sandstorm_not_installed

$[run]set +e; PATH=/vagrant/installer-tests/fake-non-x86-64-bin:$PATH timeout 5 env CURL_USER_AGENT=testing /vagrant/install.sh -d -u </dev/null >/tmp/sandstorm-installer-eof.log 2>&1; status=$?; cat /tmp/sandstorm-installer-eof.log; exit $status
$[slow]*** INSTALLATION FAILED ***
Sorry, the Sandstorm server currently only runs on x86_64 machines.
Not sending report.
You can report bugs at: http://github.com/sandstorm-io/sandstorm
$[exitcode]1
