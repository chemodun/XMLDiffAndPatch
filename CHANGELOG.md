# Changelog

## [0.6.0](https://github.com/chemodun/XMLDiffAndPatch/compare/xmldiffandpatch-v0.5.0...xmldiffandpatch-v0.6.0) (2026-05-17)


### Features

* add 'contextMenuOnly' option to watchMode for manual processing via context menu ([47f04d0](https://github.com/chemodun/XMLDiffAndPatch/commit/47f04d0ad5f64a36d016d1748736c019a119212b))
* add debug logging configuration and enhance logger functionality ([0c6fef2](https://github.com/chemodun/XMLDiffAndPatch/commit/0c6fef2445a3fd4f15dea0be448bd60f5438a370))
* add emptyDiffBehavior and validationFailBehavior options for enhanced diff handling ([58bf435](https://github.com/chemodun/XMLDiffAndPatch/commit/58bf435d35293b806d633e7412ba8f80a617c38e))
* add explorer context-menu commands for file operations in X4 Diff and Patch ([4b8908d](https://github.com/chemodun/XMLDiffAndPatch/commit/4b8908d211bfbc6e1eeed343cc3e841df87060d3))
* add hasParseError function to detect malformed XML and skip processing ([ef3661f](https://github.com/chemodun/XMLDiffAndPatch/commit/ef3661f6cbb170782881b653aec08ad7294980db))
* add icon for XML Diff and Patch ([e4a1402](https://github.com/chemodun/XMLDiffAndPatch/commit/e4a1402428473373f245715cd6c4c1caccb6c095))
* add launch and tasks configuration for VSCode extension development ([bad890c](https://github.com/chemodun/XMLDiffAndPatch/commit/bad890ce0afdc3cd086867a405565e223c6a9356))
* add pathPrefix configuration for flexible original file lookup ([1bbad87](https://github.com/chemodun/XMLDiffAndPatch/commit/1bbad87c3330254ccdb824e70e1c873061fd16ce))
* add pathPrefix option to DiskConfigFile and WatcherConfig for flexible file path handling ([716a352](https://github.com/chemodun/XMLDiffAndPatch/commit/716a3527e282cbee06ec7ac403f70d4dc71989be))
* add pathPrefix retrieval and logging for original path checks in watcher ([c9f08bd](https://github.com/chemodun/XMLDiffAndPatch/commit/c9f08bd84ec69ecfb19a3982daf6c1b5ec58440b))
* change from X4DiffAndPatch to XML Diff and Patch ([560de49](https://github.com/chemodun/XMLDiffAndPatch/commit/560de49501b25e5f16b17cd1a43255ae80873273))
* enhance configuration handling and logging for multiple watcher instances ([62264e4](https://github.com/chemodun/XMLDiffAndPatch/commit/62264e434bab85e0731888de8e6346fa53f4927b))
* enhance configuration handling by implementing inherited string retrieval for folder settings ([964144f](https://github.com/chemodun/XMLDiffAndPatch/commit/964144f0f381b4c1c564e86532c77982ce1de40e))
* enhance configuration handling with async functions, glob expansion for folder paths, and improved error handling ([ae17158](https://github.com/chemodun/XMLDiffAndPatch/commit/ae171580a61dd6b472746740b533b95f4322c06e))
* enhance file writing to use VS Code's fs API for workspace paths ([fd2595d](https://github.com/chemodun/XMLDiffAndPatch/commit/fd2595db94f2de3f80b8dd3cc8cf2b2acec0a03d))
* enhance writeOutput to use WorkspaceEdit for Local History tracking ([9276a50](https://github.com/chemodun/XMLDiffAndPatch/commit/9276a509fd2c0b43ee7a45b26deb6982338c6e8c))
* ignore non-XML files in handleSaveEvent to streamline processing ([7a8501f](https://github.com/chemodun/XMLDiffAndPatch/commit/7a8501fcab962b470525ed473c013d70bac74f67))
* implement a multiple folder "pairs" instead of single modified/diff , add settings panel for managing folder pairs, and migrate legacy settings, and update package version to 0.2.0 ([a9c22a7](https://github.com/chemodun/XMLDiffAndPatch/commit/a9c22a748cb2f2fd2407dfbe2d509859c8fd5bcb))
* implement orphan cleanup for diff files without corresponding modified files ([64087c8](https://github.com/chemodun/XMLDiffAndPatch/commit/64087c8dbbcd9057829db232b89f10f851f8fd46))
* improve file processing order in watcher to prioritize secondary folder events ([341f58f](https://github.com/chemodun/XMLDiffAndPatch/commit/341f58fe1b8d6dcf785ec95a3e3d311fe9b4f076))
* prevent unnecessary replace operations for modified elements that match later originals ([9bdf326](https://github.com/chemodun/XMLDiffAndPatch/commit/9bdf3265752040fb2487bb26939b600f9d28a329))
* update .gitignore to include test-workspace XML files ([4bbba17](https://github.com/chemodun/XMLDiffAndPatch/commit/4bbba17961c5fbe07d43a257933ef8a64e9a8dd1))
* update emptyDiffBehavior options and handling for improved output management ([4a4adfb](https://github.com/chemodun/XMLDiffAndPatch/commit/4a4adfbededd3e948939b370d2ac1e2d7325f6bd))
* update launch configuration and add test workspace settings ([42c6b5c](https://github.com/chemodun/XMLDiffAndPatch/commit/42c6b5cb643570104944e699d2b0723617994cb4))
* update license to Apache-2.0 and add repository information in package.json; add README.md with extension features and settings ([7a6ed96](https://github.com/chemodun/XMLDiffAndPatch/commit/7a6ed96537e54087c5152f7bca50c7b11c2347a9))


### Bug Fixes

* enhance comparison logic to handle close matches in diffing process ([6508608](https://github.com/chemodun/XMLDiffAndPatch/commit/65086089ee09453c49e53766f6225721e5091c63))
* simplify comparison logic in compareElements and exactlyMatches methods ([b50f041](https://github.com/chemodun/XMLDiffAndPatch/commit/b50f0419477a353defa7d4c67352ee3a92069aea))
* trim whitespace from text values in compareElements method ([aa873b3](https://github.com/chemodun/XMLDiffAndPatch/commit/aa873b37b8fef15215c7c776e4d6310c56b65ad8))
* update .gitignore to include entire test-workspace directory ([cb34360](https://github.com/chemodun/XMLDiffAndPatch/commit/cb34360256675a0f06e640acdc570765f7973279))
* update diffFolder path to use local directory for consistency ([15fc961](https://github.com/chemodun/XMLDiffAndPatch/commit/15fc9617d37bcbca55b91026d2b4fe9e9914b0dc))

## [0.1.0] – Initial release

- Core TypeScript port of DiffEngine, PatchEngine, XPathGenerator, XmlUtils
- File-save watcher (`onSave` and `onTheFly` modes)
- Both watcher directions (`mainFolderRole = modified` and `diff`)
- `reflectToMainFolder` bidirectional sync
- `passOtherFiles` copy-through support
- Loop guard to prevent infinite save loops
- Output channel logging
- Status bar indicator
