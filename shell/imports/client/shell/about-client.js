import { Template } from "meteor/templating";

import { globalDb } from "/imports/db-deprecated";

import "/imports/client/shell/styles/about-page-ui.scss";
import "/imports/client/shell/styles/about-intro-ui.scss";
import "/imports/client/shell/styles/about-changelog-ui.scss";
import "/imports/client/shell/styles/about-dependencies-ui.scss";
import "/imports/client/shell/styles/about-copyright-ui.scss";
import "/imports/client/shell/styles/about-terms-ui.scss";

Template.about.helpers({
  setDocumentTitle: function () {
    document.title = "About · " + globalDb.getServerTitle();
  },
});
