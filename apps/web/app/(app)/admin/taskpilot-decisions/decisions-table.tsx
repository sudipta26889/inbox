"use client";
import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

type Row = any; // ponytail: loose typing for an admin tool

export function DecisionsTable({ rows }: { rows: Row[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const filtered = statusFilter
    ? rows.filter((r) => r.status === statusFilter)
    : rows;
  const statuses = Array.from(new Set(rows.map((r) => r.status))).sort();

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <select
          className="border rounded px-2 py-1 text-sm"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">All statuses ({rows.length})</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Targets</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Pass 1</TableHead>
            <TableHead>Pass 2</TableHead>
            <TableHead>Cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((r) => (
            <>
              <TableRow
                key={r.id}
                onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                className="cursor-pointer"
              >
                <TableCell>{new Date(r.ranAt).toLocaleString()}</TableCell>
                <TableCell>{r.pass1Action ?? "—"}</TableCell>
                <TableCell>{r.targetIssueIds.length}</TableCell>
                <TableCell>
                  <Badge>{r.status}</Badge>
                </TableCell>
                <TableCell>
                  {r.pass1DurationMs ? `${r.pass1DurationMs}ms` : "—"}
                </TableCell>
                <TableCell>
                  {r.pass2Ran ? `${r.pass2DurationMs}ms` : "—"}
                </TableCell>
                <TableCell>${(r.pass1Cost + r.pass2Cost).toFixed(4)}</TableCell>
              </TableRow>
              {expanded === r.id && (
                <TableRow key={`${r.id}-x`}>
                  <TableCell colSpan={7}>
                    <pre className="text-xs overflow-x-auto">
                      {JSON.stringify(
                        {
                          preGateSignals: r.preGateSignals,
                          candidateIssueIds: r.candidateIssueIds,
                          pass1Decision: r.pass1Decision,
                          pass1Reason: r.pass1Reason,
                          pass2Updates: r.pass2Updates,
                          errorMsg: r.errorMsg,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </TableCell>
                </TableRow>
              )}
            </>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
