# X4 Diff and Patch

A VS Code extension that automatically generates X4-compatible XML diffs and applies XML patches on file save.

## Features

- **Auto-diff on save** - When you save a modified XML file, a diff file is generated against the original (vanilla) version.
- **Auto-patch on save** - When you save a diff file, it is applied to the original to regenerate the modified file.
- **Explorer context menu** - Right-click XML files or folders for *Reset to Original*, *Reconstruct from Diff*, and *Regenerate Diff* commands.
- **Watch modes** - `onSave`, `onTheFly` (debounced filesystem watcher), or `contextMenuOnly`.
- **Orphan cleanup** - Regenerating a diff folder removes diff files that no longer have a corresponding modified file.

## Requirements

Configure at least these three settings (workspace or folder level):

- `xmlDiffAndPatch.originalFolder` - Path to the vanilla/baseline XML files (required)
- `xmlDiffAndPatch.modifiedFolder` - Path to your modified XML files (required)
- `xmlDiffAndPatch.diffFolder` - Path where diff files are written (required)

Use `"."` to refer to the workspace folder itself. The two folders must not point to the same directory.

## Extension Settings

- `originalFolder` (default `""`) - Vanilla/baseline XML folder
- `modifiedFolder` (default `""`) - Modified XML folder
- `diffFolder` (default `""`) - Diff output folder
- `watchMode` (default `"onSave"`) - `onSave` / `onTheFly` / `contextMenuOnly`
- `reflectDiffToModified` (default `true`) - Apply diff saves back to modified folder
- `passOtherFiles` (default `true`) - Copy files not found in originalFolder as-is
- `emptyDiffBehavior` (default `"delete"`) - What to do when a diff has no operations
- `onlyFullPath` (default `false`) - Always use absolute XPath (no `//` shorthand)
- `useAllAttributes` (default `false`) - Use all attributes in XPath predicates
- `ignoreDiffInAttribute` (default `null`) - Attribute name to ignore when comparing
- `debounceMs` (default `500`) - Debounce delay for `onTheFly` mode in milliseconds
- `debug` (default `false`) - Enable verbose logging

## Release Notes

See [CHANGELOG.md](CHANGELOG.md).
