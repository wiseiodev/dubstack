interface ComparisonRow {
  graphite: string;
  dubstack: string;
}

interface ComparisonTableProps {
  rows: ComparisonRow[];
}

export function ComparisonTable({ rows }: ComparisonTableProps) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/50">
            <th className="px-4 py-3 text-left font-medium text-foreground">
              Graphite (<code className="font-mono text-xs">gt</code>)
            </th>
            <th className="px-4 py-3 text-left font-medium text-foreground">
              DubStack (<code className="font-mono text-xs">dub</code>)
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.graphite}
              className="border-b border-border last:border-0"
            >
              <td className="px-4 py-2.5">
                <code className="font-mono text-xs text-muted-foreground">
                  {row.graphite}
                </code>
              </td>
              <td className="px-4 py-2.5">
                <code className="font-mono text-xs text-primary">
                  {row.dubstack}
                </code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
