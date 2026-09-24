// Metro configured for a pnpm workspace.
//
// Metro does not follow symlinks the way Node does, so in a monorepo it has to
// be told where the workspace root is and where to look for modules. Without
// this, importing @nikahmate/domain from the app fails to resolve (ADR 0008).
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// The workspace packages ship TypeScript source rather than a build step, so
// Metro must transform them like app code.
config.resolver.disableHierarchicalLookup = false;

module.exports = config;
