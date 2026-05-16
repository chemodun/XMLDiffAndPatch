# Changelog

## [0.1.0] – Initial release

- Core TypeScript port of DiffEngine, PatchEngine, XPathGenerator, XmlUtils
- File-save watcher (`onSave` and `onTheFly` modes)
- Both watcher directions (`mainFolderRole = modified` and `diff`)
- `reflectToMainFolder` bidirectional sync
- `passOtherFiles` copy-through support
- Loop guard to prevent infinite save loops
- Output channel logging
- Status bar indicator
