'use strict';

module.exports = {
  // This gate changes configuration and restarts its isolated installation.
  // Never run it as part of a suite pointed at an existing server.
  '@disabled': process.env.RUN_RUST_RECOVERY !== '1',
  async 'Installed Rust shell survives restart and bundle update'(browser) {
    const {prepareRecovery,runRecovery}=await import('../../rust-shell/frontend/tests/recovery.mjs');
    const directory=process.env.SANDSTORM_DIR;
    const keys=await prepareRecovery(directory);
    await browser.loginDevAccount('Alice',true).uploadTestApp().frame(null).timeouts('script',30000);
    let setup;
    await browser.executeAsync(async function(keys,done) {
      try {
        await Meteor.callAsync('setTlsKeys',null,keys);
        done({grainId:location.pathname.split('/')[2],token:localStorage.getItem('Meteor.loginToken')});
      } catch(error) {done({error:error.message});}
    },[keys],result=>{setup=result.value;});
    if (setup.error) throw new Error(setup.error);
    await runRecovery(directory,process.env.SANDSTORM_TEST_BUNDLE,setup.grainId,setup.token,keys);
    browser.assert.ok(true,'installed restart and update recovery verified');
    await browser.end();
  },
};
