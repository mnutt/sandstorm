import { Meteor } from "meteor/meteor";
import { Random } from "meteor/random";
import { Accounts } from "meteor/accounts-base";

const initiateLogin = function (options, callback, dimensions) {
  // default dimensions that worked well for facebook and google
  const popup = openCenteredPopup(
    Meteor.absoluteUrl("_saml/authorize/" + options.provider + "/" + options.credentialToken),
    (dimensions && dimensions.width) || 650,
    (dimensions && dimensions.height) || 500);
  let popupClosed;
  let finished = false;
  let checkPopupOpen;

  const finish = function (error, result) {
    if (finished) return;
    finished = true;
    clearInterval(checkPopupOpen);
    window.removeEventListener("message", messageListener);
    callback(error, result);
  };

  const messageListener = function (event) {
    if (event.origin !== window.location.origin) return;
    if (event.source !== popup) return;
    const data = event.data;
    if (!data || data.type !== "sandstorm-saml-login") return;
    if (data.credentialToken !== options.credentialToken) return;
    if (typeof data.credentialSecret !== "string" || !data.credentialSecret) return;

    finish(null, {
      credentialToken: data.credentialToken,
      credentialSecret: data.credentialSecret,
    });
  };

  window.addEventListener("message", messageListener);

  checkPopupOpen = setInterval(function () {
    try {
      // Fix for #328 - added a second test criteria (popup.closed === undefined)
      // to humour this Android quirk:
      // http://code.google.com/p/android/issues/detail?id=21061
      popupClosed = popup.closed || popup.closed === undefined;
    } catch (e) {
      // For some unknown reason, IE9 (and others?) sometimes (when
      // the popup closes too quickly?) throws "SCRIPT16386: No such
      // interface supported" when trying to read 'popup.closed'. Try
      // again in 100ms.
      return;
    }

    if (popupClosed) {
      finish(new Error("SAML login did not complete."));
    }
  }, 100);
};

const openCenteredPopup = function (url, width, height) {
  const screenX = typeof window.screenX !== "undefined"
        ? window.screenX : window.screenLeft;
  const screenY = typeof window.screenY !== "undefined"
        ? window.screenY : window.screenTop;
  const outerWidth = typeof window.outerWidth !== "undefined"
        ? window.outerWidth : document.body.clientWidth;
  const outerHeight = typeof window.outerHeight !== "undefined"
        ? window.outerHeight : (document.body.clientHeight - 22);
  // XXX what is the 22?

  // Use `outerWidth - width` and `outerHeight - height` for help in
  // positioning the popup centered relative to the current window
  const left = screenX + (outerWidth - width) / 2;
  const top = screenY + (outerHeight - height) / 2;
  const features = ("width=" + width + ",height=" + height +
                  ",left=" + left + ",top=" + top + ",scrollbars=yes");

  const newwindow = window.open(url, "Login", features);
  if (newwindow.focus)
    newwindow.focus();
  return newwindow;
};

const loginWithSaml = function (options, callback) {
  options = options || {};

  // TODO(cleanup): AFAICT "default" is the only provider; why is this an option?
  if (!options.proivder) options.provider = "default";

  const credentialToken = "_" + Random.hexString(40);
  options.credentialToken = credentialToken;

  initiateLogin(options, function (error, result) {
    if (error) {
      callback(error);
      return;
    }

    Accounts.callLoginMethod({
      methodArguments: [{ saml: true,
                          credentialToken: result.credentialToken,
                          credentialSecret: result.credentialSecret }],
      userCallback: callback,
    });
  });
};

export { loginWithSaml };
