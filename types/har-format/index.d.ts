interface HARFormatEntry {
  [key: string]: unknown;
}

interface HARFormatLog {
  entries?: HARFormatEntry[];
  [key: string]: unknown;
}
