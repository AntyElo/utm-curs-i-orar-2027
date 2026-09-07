/**
 * Stage 5b: repair of truncated column borders.
 *
 * Excel exports occasionally clip the *top* of an interior column border: the
 * ruling that separates two group columns stops a few points below the slot
 * row it belongs to, even though it is drawn above the row and again for the
 * rest of it. Text on the first line of that row then finds no border between
 * the two columns, so `enclosingCell` returns one box spanning both – which
 * `dropEngulfingCells` rightly rejects, taking the lesson with it.
 *
 * The repair restores the missing stub, and nothing else. It never removes a
 * border and never widens a cell: closing a vertical gap can only ever split a
 * box into the two columns it was drawn from, so a lesson genuinely merged
 * across columns (colspan) must stay untouched. The guards below exist to tell
 * the two apart – above all `resumesOnRuling`, which recognises the legitimate
 * shape this defect imitates: a row whose upper half really is merged and whose
 * lower half really is split, where the border resumes exactly on the drawn
 * half-row ruling.
 */
import { overlap1d, type Grid, type LineSegment } from "./geometry";
import type { SlotRow, TableLayout } from "./table-detector";

/** How close a vertical segment must sit to a column boundary to be that boundary. */
const BOUNDARY_MATCH_PT = 1.0;
/** Longest missing top stub we are willing to restore – about one printed line plus leading. */
const MAX_MISSING_BORDER_PT = 6.0;
/** Longest missing internal discontinuity we are willing to bridge – narrower than top stub. */
const MAX_INTERNAL_GAP_PT = 3.5;
/** A resume point this close to a horizontal ruling is a structural split, not a defect. */
const RULING_MATCH_PT = 0.8;
/** Slack when testing that a segment reaches a row edge. */
const EDGE_TOLERANCE_PT = 0.5;
/** Two group columns share a boundary when their edges are this close. */
const SHARED_EDGE_PT = 0.5;

export interface BoundaryRepair {
  x: number;
  day: SlotRow["day"];
  start_time: string;
  /** Where the drawn border resumed; the restored stub spans [row.y0, resumedAt] or [gapFrom, resumedAt]. */
  resumedAt: number;
  gap: number;
  kind?: "top_stub" | "internal_gap";
}

export interface GridRepairResult {
  grid: Grid;
  repairs: BoundaryRepair[];
}

/**
 * Restore interior column borders whose top stub or internal discontinuity is missing inside a single slot row.
 * Returns the grid unchanged (same object) when there is nothing to repair.
 */
export function repairTruncatedColumnBorders(grid: Grid, layout: TableLayout): GridRepairResult {
  const repairs: BoundaryRepair[] = [];
  const replacements = new Map<LineSegment, LineSegment>();
  const additions: LineSegment[] = [];

  for (const boundary of interiorBoundaries(layout)) {
    const column = grid.vertical.filter((segment) => Math.abs(segment.at - boundary) <= BOUNDARY_MATCH_PT);
    if (column.length === 0) continue;
    for (const row of layout.rows) {
      // Case 1: missing top stub
      const topStubRepair = repairBoundaryInRow(grid, layout, column, boundary, row);
      if (topStubRepair) {
        replacements.set(topStubRepair.segment, { ...topStubRepair.segment, from: row.y0 });
        repairs.push({
          x: boundary,
          day: row.day,
          start_time: row.start_time,
          resumedAt: topStubRepair.segment.from,
          gap: topStubRepair.gap,
          kind: "top_stub",
        });
        continue;
      }

      // Case 2: short internal discontinuity
      const internalGapRepair = repairInternalGapInRow(grid, layout, column, boundary, row);
      if (internalGapRepair) {
        additions.push({ at: boundary, from: internalGapRepair.from, to: internalGapRepair.to });
        repairs.push({
          x: boundary,
          day: row.day,
          start_time: row.start_time,
          resumedAt: internalGapRepair.to,
          gap: internalGapRepair.gap,
          kind: "internal_gap",
        });
      }
    }
  }

  if (replacements.size === 0 && additions.length === 0) return { grid, repairs };

  const updatedVertical =
    replacements.size > 0
      ? grid.vertical.map((segment) => replacements.get(segment) ?? segment)
      : [...grid.vertical];

  return {
    grid: { ...grid, vertical: additions.length > 0 ? [...updatedVertical, ...additions] : updatedVertical },
    repairs,
  };
}

/** Boundaries *between* adjacent group columns; the table's outer edges are never repaired. */
function interiorBoundaries(layout: TableLayout): number[] {
  const boundaries: number[] = [];
  for (let index = 0; index + 1 < layout.groups.length; index += 1) {
    const left = layout.groups[index];
    const right = layout.groups[index + 1];
    if (Math.abs(right.x0 - left.x1) <= SHARED_EDGE_PT) boundaries.push((left.x1 + right.x0) / 2);
  }
  return boundaries;
}

function repairBoundaryInRow(
  grid: Grid,
  layout: TableLayout,
  column: LineSegment[],
  boundary: number,
  row: SlotRow,
): { segment: LineSegment; gap: number } | null {
  const height = row.y1 - row.y0;
  if (height <= 0) return null;

  // The border must be drawn for the rest of the row, starting somewhere inside it.
  const candidate = column.find(
    (segment) => segment.from > row.y0 + EDGE_TOLERANCE_PT && segment.from < row.y1 && segment.to >= row.y1 - EDGE_TOLERANCE_PT,
  );
  if (!candidate) return null;

  const gap = candidate.from - row.y0;
  // A gap longer than a printed line, or reaching into the middle of the row, is not a
  // clipped stub – it is a cell that legitimately spans both columns.
  if (gap > MAX_MISSING_BORDER_PT || gap >= height * 0.5) return null;

  // Nothing else may already cover the gap; if it does, the border is not missing at all.
  const covered = column.some((segment) => segment !== candidate && overlap1d(segment.from, segment.to, row.y0, candidate.from) > EDGE_TOLERANCE_PT);
  if (covered) return null;

  // The border must continue from above: it is the same ruling, clipped, not a new one.
  const continuesFromAbove = column.some(
    (segment) => segment !== candidate && segment.from < row.y0 - EDGE_TOLERANCE_PT && segment.to >= row.y0 - EDGE_TOLERANCE_PT,
  );
  if (!continuesFromAbove) return null;

  // Decisive guard: a border that resumes exactly on a drawn ruling marks a real
  // half-row split (merged above, separate below) and must be left alone.
  if (resumesOnRuling(grid, boundary, candidate.from)) return null;

  // Both sides below the gap must be independently enclosed, or there are no two
  // cells for the restored border to separate.
  if (!hasIndependentSides(grid, layout, boundary, candidate.from, row.y1)) return null;

  return { segment: candidate, gap };
}

/** Is there a horizontal ruling crossing the boundary at the height the border resumes? */
function resumesOnRuling(grid: Grid, boundary: number, resumeAt: number): boolean {
  return grid.horizontal.some(
    (line) =>
      Math.abs(line.at - resumeAt) <= RULING_MATCH_PT &&
      line.from <= boundary + RULING_MATCH_PT &&
      line.to >= boundary - RULING_MATCH_PT,
  );
}

/**
 * The outer edge of each column adjoining the boundary must itself be drawn across the
 * band below the gap – proof that a separate cell exists on either side.
 */
function hasIndependentSides(grid: Grid, layout: TableLayout, boundary: number, y0: number, y1: number): boolean {
  const left = layout.groups.find((group) => Math.abs(group.x1 - boundary) <= BOUNDARY_MATCH_PT);
  const right = layout.groups.find((group) => Math.abs(group.x0 - boundary) <= BOUNDARY_MATCH_PT);
  if (!left || !right) return false;
  return spansBand(grid, left.x0, y0, y1) && spansBand(grid, right.x1, y0, y1);
}

function spansBand(grid: Grid, at: number, y0: number, y1: number): boolean {
  return grid.vertical.some(
    (segment) =>
      Math.abs(segment.at - at) <= BOUNDARY_MATCH_PT &&
      segment.from <= y0 + EDGE_TOLERANCE_PT &&
      segment.to >= y1 - EDGE_TOLERANCE_PT,
  );
}

/**
 * Restore an internal discontinuity in an otherwise continuous vertical column boundary.
 * Requires segments of the same boundary to exist immediately above and below the gap inside the slot row.
 */
function repairInternalGapInRow(
  grid: Grid,
  layout: TableLayout,
  column: LineSegment[],
  boundary: number,
  row: SlotRow,
): { from: number; to: number; gap: number } | null {
  const height = row.y1 - row.y0;
  if (height <= 0) return null;

  const inRow = column
    .filter((segment) => segment.to > row.y0 - EDGE_TOLERANCE_PT && segment.from < row.y1 + EDGE_TOLERANCE_PT)
    .sort((a, b) => a.from - b.from);

  for (let i = 0; i + 1 < inRow.length; i++) {
    const segA = inRow[i];
    const segB = inRow[i + 1];
    const gap = segB.from - segA.to;

    // Guard C: very small positive gap narrower than top-stub threshold
    if (gap <= 0.01 || gap > MAX_INTERNAL_GAP_PT) continue;

    // Guard D: both pieces and the gap belong to the same slot row
    if (segA.to <= row.y0 + EDGE_TOLERANCE_PT || segB.from >= row.y1 - EDGE_TOLERANCE_PT) continue;

    // Guard B: segment exists immediately above AND below
    if (segA.from > row.y0 + EDGE_TOLERANCE_PT) continue;
    if (segB.to < row.y1 - EDGE_TOLERANCE_PT) continue;

    // Nothing else already covers the gap
    const covered = column.some(
      (segment) => segment !== segA && segment !== segB && overlap1d(segment.from, segment.to, segA.to, segB.from) > EDGE_TOLERANCE_PT,
    );
    if (covered) continue;

    // Guard E: no legitimate horizontal ruling at either gap edge
    if (resumesOnRuling(grid, boundary, segA.to) || resumesOnRuling(grid, boundary, segB.from)) continue;

    // Guard F: adjacent outer column boundaries exist across the gap band
    if (!hasIndependentSides(grid, layout, boundary, segA.to, segB.from)) continue;

    return { from: segA.to, to: segB.from, gap };
  }

  return null;
}

