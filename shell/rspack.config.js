const { defineConfig } = require("@meteorjs/rspack");
const { IgnorePlugin } = require("@rspack/core");
const path = require("node:path");

module.exports = defineConfig((Meteor) => ({
  output: {
    clean: {
      // Rspack can pass absolute paths. Match generated directories relative to its output
      // root, so a checkout under a parent named "build" does not lose all public/private assets.
      keep(filename) {
        const outputRoot = path.resolve(__dirname, Meteor.isServer ? "private" : "public");
        const relative = path.isAbsolute(filename) ? path.relative(outputRoot, filename) : filename;
        return !/^build(?:-[^/\\]+)?(?:[/\\]|$)/.test(relative);
      },
    },
  },
  performance: Meteor.isServer
    ? false
    : {
        maxAssetSize: 1024 * 1024,
        maxEntrypointSize: 1536 * 1024,
      },
  resolve: Meteor.isServer
    ? {
        alias: {
          // Undici exposes an optional SQLite cache implementation from its
          // package root. Sandstorm does not enable that interceptor.
          "node:sqlite": false,

          // @root/keypairs probes these native packages only on very old Node
          // releases. Meteor's dev bundle has crypto.generateKeyPairSync().
          ursa: false,
          "ursa-optional": false,
        },
      }
    : undefined,
  module: {
    rules: [
      {
        test: /\.scss$/i,
        use: [
          {
            loader: "sass-loader",
            options: {
              api: "modern-compiler",
              implementation: require.resolve("sass-embedded"),
              sassOptions: {
                loadPaths: [
                  path.resolve(__dirname, "imports/client"),
                  path.resolve(__dirname, "imports/client/styles"),
                ],
              },
            },
          },
        ],
        type: "css/auto",
      },
    ],
  },
  plugins: Meteor.isServer
    ? [
        new IgnorePlugin({
          resourceRegExp: /^(node:sqlite|ursa|ursa-optional)$/,
        }),
      ]
    : [],
}));
