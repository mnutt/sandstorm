import { Template } from "meteor/templating";

import { globalDb } from "/imports/db-deprecated";

import "/imports/client/shell/styles/about-ui.scss";

Template.about.helpers({
  setDocumentTitle: function () {
    document.title = "About · " + globalDb.getServerTitle();
  },
});
