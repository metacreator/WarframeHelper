'use strict';
// Chrome and Edge name the extension API "chrome" (with promises, like Firefox's "browser"); Firefox has both.
globalThis.browser ??= globalThis.chrome;
