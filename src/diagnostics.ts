export interface DiagnosticRange {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}

export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  file: string;
  range: DiagnosticRange;
  path?: string;
  hint?: string;
}
