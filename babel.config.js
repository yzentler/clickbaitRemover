// Jest only: transpile the extension's ES modules to CommonJS for tests.
// The extension itself ships untranspiled (service worker runs as a module).
module.exports = {
    env: {
        test: {
            plugins: ['@babel/plugin-transform-modules-commonjs'],
        },
    },
};
