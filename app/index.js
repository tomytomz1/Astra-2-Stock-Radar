/**
 * App entry point.
 *
 * `main` used to be `node_modules/expo/AppEntry.js`, a path resolved relative to this package.
 * Hoisting node_modules (required for Metro — see the root `.npmrc`) moved `expo` to the
 * workspace root, so that relative path stopped resolving and Metro failed with
 * "Cannot resolve entry file". This form is layout-independent: it imports `expo` through normal
 * module resolution, so it works under either linker.
 *
 * `registerRootComponent` also handles the environment setup that `AppEntry` used to do, and is
 * the documented entry for SDK 50 and later.
 */
import { registerRootComponent } from 'expo';

import App from './App';

registerRootComponent(App);
