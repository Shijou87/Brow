interface Entry {
  readonly filesystem?: unknown;
  readonly fullPath?: string;
  readonly isDirectory?: boolean;
  readonly isFile?: boolean;
  readonly name?: string;
}

interface DirectoryEntry extends Entry {
  readonly isDirectory: true;
}
