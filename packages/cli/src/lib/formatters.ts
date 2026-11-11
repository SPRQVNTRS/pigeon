export interface TableOptions {
  align?: Array<'left' | 'right'>;
}

/**
 * Renders a simple aligned text table without any third-party library.
 */
export function formatTable(
  headers: string[],
  rows: string[][],
  options: TableOptions = {},
): string {
  const align = options.align ?? headers.map(() => 'left' as const);
  const allRows = [headers, ...rows];

  // Compute column widths from all rows
  const widths = headers.map((_, colIdx) =>
    Math.max(...allRows.map((row) => (row[colIdx] ?? '').length)),
  );

  function renderRow(row: string[]): string {
    return row
      .map((cell, colIdx) => {
        const width = widths[colIdx] ?? 0;
        const colAlign = align[colIdx] ?? 'left';
        const padded =
          colAlign === 'right'
            ? (cell ?? '').padStart(width)
            : (cell ?? '').padEnd(width);
        return padded;
      })
      .join('  ');
  }

  const headerLine = renderRow(headers);
  const separator = widths.map((w) => '-'.repeat(w)).join('  ');
  const dataLines = rows.map(renderRow);

  return [headerLine, separator, ...dataLines].join('\n');
}
