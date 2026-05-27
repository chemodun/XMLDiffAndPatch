// Core types shared across diff/patch engine, watcher, and config.

/** What to do when a diff produces no operations (the files are identical). */
export type EmptyDiffBehavior = 'write' | 'delete' | 'warn' | 'warnDelete';

/**
 * What to do when structural validation of a generated diff file fails.
 * ('off' disables the check entirely.)
 */
export type ValidationFailBehavior = 'warn' | 'error' | 'off';

/** Options controlling diff generation behaviour. Port of C# DiffOptions. */
export interface DiffOptions {
  /** When true, restrict to full absolute XPath; when false (default), use // shorthand when globally unique. */
  onlyFullPath: boolean;
  /** Include all attributes (not just the minimal distinguishing set) in XPath predicates. */
  useAllAttributes: boolean;
  /** Attribute name to ignore when comparing elements. null = compare all attributes. */
  ignoreDiffInAttribute: string | null;
  /** When true, skip adding attributes to a path step when name alone is unique; when name is not unique, prefer child-path continuation over attributes. */
  compactPath: boolean;
  /** When true, always include at least the first attribute in XPath steps even when name alone is sufficient. */
  qualifiedPath: boolean;
}

/** Resolved and validated watcher configuration (derived from VS Code settings or disk file). */
export interface WatcherConfig {
  originalFolder: string;
  modifiedFolder: string;
  diffFolder: string;
  /** Absolute path to diff.xsd, or null if the file does not exist. */
  xsdPath: string | null;
  onlyFullPath: boolean;
  useAllAttributes: boolean;
  ignoreDiffInAttribute: string | null;
  /** When true, skip adding attributes when name alone is unique; prefer child-path continuation when name is not unique. */
  compactPath: boolean;
  /** When true, always include at least the first attribute even when name alone is sufficient. */
  qualifiedPath: boolean;
  reflectDiffToModified: boolean;
  passOtherFiles: boolean;
  allowDoubles: boolean;
  watchMode: 'onSave' | 'onTheFly' | 'contextMenuOnly';
  debounceMs: number;
  /** Action when diff produces no operations (saved file is identical to the original). */
  emptyDiffBehavior: EmptyDiffBehavior;
  /** Action when structural validation of a generated diff file fails. */
  validationFailBehavior: ValidationFailBehavior;
  /**
   * Path segment prepended to the file's relative path when looking up the
   * original file.  Only used to locate originals — never applied to the
   * output (diff / patch / copy destination) path.
   * Empty string means no prefix.
   */
  pathPrefix: string;
  /** Human-readable label for log messages (e.g. "folder:MyMod" or "global"). */
  configLabel: string;
  /** Where this configuration was read from. */
  configSource: 'vscode-folder' | 'vscode-global';
  /** When true, emit verbose debug messages to the output channel. */
  debug: boolean;
}

/** Minimal logging interface used by the engine layer. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Emits only when debug mode is enabled for this config. */
  debug(message: string): void;
}

/** Logger that discards all messages. */
export const NoOpLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};
