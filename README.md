# XML Diff and Patch

A VS Code extension that automatically generates and applies **RFC 5261-compatible** XML patch files using XPath selectors, watching modified XML files and producing diffs on save.

Originally developed for modding **X4: Foundations** (which uses RFC 5261 XML patches for game-data mods), the extension is fully generic and works with any XML workflow that follows the RFC 5261 patch format.

## Features

- **Auto-diff on save** — Save a modified XML file and a diff is generated against the original (vanilla) version automatically.
- **Auto-patch on save** — Save a diff file and it is applied to the original to regenerate the modified file.
- **Multiple folder pairs** — Configure any number of `modifiedFolder`/`diffFolder` pairs under a single `originalFolder`, each with an optional `pathPrefix`.
- **Glob pattern support** — All folder paths accept `*`, `?`, and `**` glob wildcards so a single config entry can cover multiple mod directories.
- **Explorer context menu** — Right-click XML files or folders for *Reset to Original*, *Reconstruct from Diff*, and *Regenerate Diff* commands.
- **Watch modes** — `onSave`, `onTheFly` (debounced filesystem watcher), or `contextMenuOnly`.
- **Settings sidebar** — A dedicated explorer panel lets you add, edit, and remove folder pairs per scope (User / Workspace / Folder) without editing JSON directly.
- **XSD validation** — Optionally validate generated diff files against a schema, with configurable fail behavior.
- **Empty diff handling** — Choose to write, delete, warn, or warn-and-delete when a save produces no diff operations.
- **Orphan cleanup** — Regenerating a diff folder removes diff files that no longer have a corresponding modified file.

## Requirements

Set `xmlDiffAndPatch.originalFolder` to the path containing the baseline XML files, then add at least one entry to `xmlDiffAndPatch.folderPairs`.

**Minimal workspace settings example:**

```json
{
  "xmlDiffAndPatch.originalFolder": "C:/Games/X4 Foundations/data",
  "xmlDiffAndPatch.folderPairs": [
    {
      "modifiedFolder": "${workspaceFolder}/src",
      "diffFolder": "${workspaceFolder}/diff",
      "pathPrefix": "libraries"
    }
  ]
}
```

- `originalFolder` — Path to the vanilla/baseline XML files. Always required.
- `folderPairs` — Array of pairs to process. Each pair needs `modifiedFolder` and `diffFolder`; `pathPrefix` is optional and is inserted between `originalFolder` and the file's relative path when looking up the original.
- Use `"."` to refer to the workspace folder itself.
- `modifiedFolder` and `diffFolder` must not point to the same directory.
- All three folder fields support glob patterns (`*`, `?`, `**`).

## Extension Settings

All settings are under the `xmlDiffAndPatch` namespace.

| Setting | Default | Description |
|---|---|---|
| `originalFolder` | `""` | Path to the vanilla/baseline XML folder. Required. |
| `folderPairs` | `[]` | Array of `{ modifiedFolder, diffFolder, pathPrefix? }` objects. |
| `watchMode` | `"onSave"` | `onSave` — trigger on explicit save; `onTheFly` — trigger on any FS change (debounced); `contextMenuOnly` — disable auto-watching. |
| `debounceMs` | `500` | Debounce delay in ms for `onTheFly` mode. |
| `reflectDiffToModified` | `true` | When a diff file is saved, apply it to the original to regenerate the modified file. |
| `passOtherFiles` | `true` | Copy files not found in `originalFolder` as-is to the output folder. |
| `emptyDiffBehavior` | `"delete"` | Action when diff produces no operations: `write`, `delete`, `warn`, or `warnDelete`. |
| `onlyFullPath` | `false` | Always emit absolute XPath (no `//` shorthand). |
| `useAllAttributes` | `false` | Include all attributes in XPath predicates, not just disambiguating ones. |
| `ignoreDiffInAttribute` | `null` | Attribute name to ignore when comparing elements (e.g. `"version"`). |
| `xsdPath` | `"./diff.xsd"` | Path to an XSD schema for validating generated diff files. Relative paths resolve from workspace root. |
| `validationFailBehavior` | `"warn"` | On schema validation failure: `warn` (write anyway), `error` (skip write), or `off` (disable validation). |
| `showDiffEditorOnSave` | `false` | Open a side-by-side diff editor after generating a diff file. |
| `allowDoubles` | `false` | Skip duplicate-element guard when applying `<add>` operations during patch. |
| `debug` | `false` | Enable verbose debug logging in the output channel. |

## X4: Foundations Usage

X4: Foundations uses RFC 5261 XML patches to allow mods to modify game data without replacing entire files. This extension automates the diff/patch cycle:

1. Set `originalFolder` to the extracted X4 game-data folder.
2. Add a folder pair pointing at your mod's source XML and the diff output directory.
3. Edit and save your modified XML — the extension writes the RFC 5261 patch automatically.
4. Include the diff files in your mod package.

## Release Notes

See [CHANGELOG.md](CHANGELOG.md).
