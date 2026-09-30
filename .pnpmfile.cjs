/**
 * .pnpmfile.cjs — pnpm hook that strips @girs/* (Linux-only GObject
 * introspection type stubs) from any package's dependencies on non-Linux
 * platforms, so macOS / Windows users never download them.
 */
const IS_LINUX = process.platform === 'linux';

module.exports = {
  hooks: {
    readPackage(pkg) {
      if (IS_LINUX) return pkg;
      // Walk every dependency section and drop @girs/* entries.
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        const deps = pkg[section];
        if (!deps) continue;
        for (const key of Object.keys(deps)) {
          if (key.startsWith('@girs/')) {
            delete deps[key];
          }
        }
      }
      return pkg;
    }
  }
};
