/**
 * The only module that imports Pierre's own entry points. `npm run build:pierre`
 * bundles it into client/vendor/pierre.js, which the plugin imports instead.
 *
 * Why it is vendored: Paseo compiles a plugin's own imports, but it cannot
 * resolve a dependency's transitive graph — it stops at `lru_map`, which
 * @pierre/diffs's worker module imports and which is installed and declared by
 * the package. That resolution is not configurable from a manifest, so the
 * editor is bundled here by our own esbuild into one local file with no bare
 * specifiers left in it. This file is not part of the plugin's compile.
 */
// `processFile` builds a hydrated diff from a patch plus both file texts, which
// is how a file this change added becomes editable: Pierre only loads the file
// pair for a changed or renamed file on its own.
export { parsePatchFiles, processFile } from "@pierre/diffs";
export { CodeView, EditProvider } from "@pierre/diffs/react";
// The editor itself: `EditProvider` needs a factory, and the factory is the
// Editor class the edit entry ships.
export { Editor } from "@pierre/diffs/edit";
