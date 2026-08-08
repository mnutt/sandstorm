import { Template } from "meteor/templating";
import { Router } from "meteor/vlasky:galvanized-iron-router";

import "/imports/client/styleguide/styles/styleguide-ui.scss";

Template.styleguide.events({
  "submit form"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
  },
});

Router.map(function () {
  this.route("styleguide", {
    path: "/styleguide",
  });
});
