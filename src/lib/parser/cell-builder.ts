/**
 * Stage 6: cell reconstruction. Every text item is attributed to the drawn
 * cell that encloses it; items inside the same cell are grouped into visual
 * lines. The cell rectangle is then projected onto the group columns and slot
 * rows, which is how merged cells (colspan / rowspan) are resolved.
 */
import { backgroundAt, cellKey, centerOf, enclosingCell, overlap1d, type CellBounds, type Grid } from "./geometry";
import type { TextItem } from "./pdf-extract";
import { GROUP_CODE_RE, type SlotRow, type TableLayout } from "./table-detector";
import type { DayName } from "@/lib/models";

/** Items whose vertical centres differ by less than this belong to the same visual line. */
const SAME_LINE_TOLERANCE_PT = 1.0;
/** A column/row counts as covered when at least this share of it lies under the cell. */
const MIN_COVERAGE_RATIO = 0.5;
/** A mapped cell must lie this much inside the slot rows it covers. */
const MIN_INSIDE_ROWS_RATIO = 0.6;
/** Minimum margin (pt) on both sides of a horizontal ruling to count as materially straddling it. */
const MIN_RULING_STRADDLE_PT = 0.6;
/** Minimum horizontal overlap between an item and a ruling to count as crossing. */
const MIN_RULING_OVERLAP_PT = 0.5;
/** Tolerance for text items extending beyond the enclosing cell boundaries. */
const CELL_OVERFLOW_TOLERANCE_PT = 0.5;

export interface TableCell {
  key: string;
  page: number;
  bounds: CellBounds;
  lines: string[];
  background: string | null;
  groups: string[];
  day: DayName | null;
  rows: SlotRow[];
  position: RowPosition;
}

export interface CellBuildResult {
  cells: TableCell[];
  /** Cells with text that are inside the table but could not be assigned to any group/slot. */
  orphans: TableCell[];
}

export function buildCells(texts: TextItem[], grid: Grid, layout: TableLayout, page: number): CellBuildResult {
  const byCell = new Map<string, { bounds: CellBounds; items: TextItem[] }>();

  for (const item of texts) {
    const { cx, cy } = centerOf(item);
    if (!isInsideTable(cx, cy, layout)) continue;
    const found = enclosingCell(grid, cx, cy);
    if (!found) continue;
    const bounds = clampToTable(found, layout);
    if (!itemBelongsInCell(item, bounds, grid)) continue;
    const key = cellKey(bounds);
    const bucket = byCell.get(key) ?? { bounds, items: [] };
    bucket.items.push(item);
    byCell.set(key, bucket);
  }

  const cells: TableCell[] = [];
  const orphans: TableCell[] = [];
  for (const [key, bucket] of byCell) {
    const groups = groupsCoveredBy(bucket.bounds, layout);
    const rows = rowsCoveredBy(bucket.bounds, layout.rows);
    const cell: TableCell = {
      key,
      page,
      bounds: bucket.bounds,
      lines: itemsToLines(bucket.items),
      background: backgroundAt(grid, bucket.bounds),
      groups,
      day: rows[0]?.day ?? null,
      rows,
      position: rowPosition(bucket.bounds, rows),
    };
    const mapped = groups.length > 0 && rows.length > 0 && sitsInsideRows(bucket.bounds, rows) && !isHeaderRemnant(cell);
    if (mapped) cells.push(cell);
    else orphans.push(cell);
  }

  const filteredCells = dropEngulfingCells(cells, orphans);
  filteredCells.sort((a, b) => a.bounds.y0 - b.bounds.y0 || a.bounds.x0 - b.bounds.x0);
  return { cells: filteredCells, orphans };
}

/**
 * A TextItem must geometrically belong inside its reconstructed cell,
 * rather than merely having its center sampled inside it.
 * Items whose bounding box materially straddles a drawn grid ruling
 * or extends beyond the enclosing cell boundaries are rejected.
 */
function itemBelongsInCell(item: TextItem, cell: CellBounds, grid: Grid): boolean {
  if (item.y1 > cell.y1 + CELL_OVERFLOW_TOLERANCE_PT) return false;
  for (const line of grid.horizontal) {
    if (line.at > item.y0 + MIN_RULING_STRADDLE_PT && line.at < item.y1 - MIN_RULING_STRADDLE_PT) {
      if (overlap1d(line.from, line.to, item.x0, item.x1) > MIN_RULING_OVERLAP_PT) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Sanity defence: a reconstructed cell should not silently engulf other independently
 * reconstructed cells occupying the same slot row. Engulfing cells are demoted to orphans.
 */
function dropEngulfingCells(cells: TableCell[], orphans: TableCell[]): TableCell[] {
  const result: TableCell[] = [];
  for (const cell of cells) {
    const engulfsOther = cells.some((other) => {
      if (other === cell) return false;
      if (other.day !== cell.day) return false;
      const sharesRow = cell.rows.some((r1) => other.rows.some((r2) => r2.day === r1.day && r2.start_time === r1.start_time));
      if (!sharesRow) return false;
      const overlapY = overlap1d(cell.bounds.y0, cell.bounds.y1, other.bounds.y0, other.bounds.y1);
      const minH = Math.min(cell.bounds.y1 - cell.bounds.y0, other.bounds.y1 - other.bounds.y0);
      if (overlapY < minH * 0.5) return false;
      const widthCell = cell.bounds.x1 - cell.bounds.x0;
      const widthOther = other.bounds.x1 - other.bounds.x0;
      return (
        cell.bounds.x0 <= other.bounds.x0 + 1 &&
        cell.bounds.x1 >= other.bounds.x1 - 1 &&
        widthCell > widthOther + 10
      );
    });
    if (engulfsOther) orphans.push(cell);
    else result.push(cell);
  }
  return result;
}

/**
 * Text sitting exactly on a ruling gets no border between it and the next band, so its
 * "cell" swallows the header row. Such a box reaches far outside the slot rows it was
 * mapped to and is not a lesson.
 */
function sitsInsideRows(bounds: CellBounds, rows: SlotRow[]): boolean {
  const height = bounds.y1 - bounds.y0;
  if (height <= 0) return false;
  const covered = overlap1d(bounds.y0, bounds.y1, rows[0].y0, rows[rows.length - 1].y1);
  return covered >= height * MIN_INSIDE_ROWS_RATIO;
}

/**
 * A cell holding nothing but a group code is a leftover of the header row – group
 * codes label columns, they are never the content of a lesson.
 */
function isHeaderRemnant(cell: TableCell): boolean {
  return cell.lines.length === 1 && GROUP_CODE_RE.test(cell.lines[0].trim());
}

/**
 * Nothing in the table body reaches past the group columns or the day blocks. Where a
 * border is missing the enclosing box latches onto the next ruling outside the table
 * (the repeated time column, the outer frame); clamping keeps every line of one visual
 * cell on the same key so the cell is not split in two.
 */
function clampToTable(bounds: CellBounds, layout: TableLayout): CellBounds {
  const { x0, x1, y0, y1 } = layout.bounds;
  return {
    x0: Math.max(bounds.x0, x0),
    x1: Math.min(bounds.x1, x1),
    y0: Math.max(bounds.y0, y0),
    y1: Math.min(bounds.y1, y1),
  };
}

function isInsideTable(cx: number, cy: number, layout: TableLayout): boolean {
  const { bounds } = layout;
  return cx >= bounds.x0 - 1 && cx <= bounds.x1 + 1 && cy >= bounds.y0 - 1 && cy <= bounds.y1 + 1;
}

/** Colspan resolution: which group columns does the cell rectangle cover? */
export function groupsCoveredBy(bounds: CellBounds, layout: TableLayout): string[] {
  return layout.groups
    .filter((group) => {
      const width = group.x1 - group.x0;
      return overlap1d(bounds.x0, bounds.x1, group.x0, group.x1) >= width * MIN_COVERAGE_RATIO;
    })
    .map((group) => group.name);
}

/**
 * Rowspan resolution: which slot rows does the cell rectangle cover?
 * A cell may be a half-row (week parity split), so coverage is measured
 * against the smaller of the two heights.
 */
export function rowsCoveredBy(bounds: CellBounds, rows: SlotRow[]): SlotRow[] {
  const cellHeight = bounds.y1 - bounds.y0;
  const covered = rows
    .filter((row) => {
      const reference = Math.min(row.y1 - row.y0, cellHeight);
      return overlap1d(bounds.y0, bounds.y1, row.y0, row.y1) >= reference * MIN_COVERAGE_RATIO;
    })
    .sort((a, b) => a.y0 - b.y0);
  return keepDominantDay(bounds, covered);
}

/**
 * No lesson runs from one day into the next. When a box reaches over a day
 * boundary – text drawn across the ruling – it belongs to the day it covers most.
 */
function keepDominantDay(bounds: CellBounds, rows: SlotRow[]): SlotRow[] {
  const perDay = new Map<DayName, number>();
  for (const row of rows) {
    const shared = overlap1d(bounds.y0, bounds.y1, row.y0, row.y1);
    perDay.set(row.day, (perDay.get(row.day) ?? 0) + shared);
  }
  if (perDay.size <= 1) return rows;
  const [dominant] = [...perDay.entries()].sort((a, b) => b[1] - a[1])[0];
  return rows.filter((row) => row.day === dominant);
}

/** A cell shorter than this share of its slot row is a top/bottom half (odd/even week). */
const FULL_ROW_RATIO = 0.75;

export type RowPosition = "full" | "top" | "bottom";

/** Where does the cell sit inside its (single) slot row? */
export function rowPosition(bounds: CellBounds, rows: SlotRow[]): RowPosition {
  if (rows.length !== 1) return "full";
  const row = rows[0];
  const rowHeight = row.y1 - row.y0;
  if (bounds.y1 - bounds.y0 >= rowHeight * FULL_ROW_RATIO) return "full";
  const cellCenter = (bounds.y0 + bounds.y1) / 2;
  const rowCenter = (row.y0 + row.y1) / 2;
  return cellCenter < rowCenter ? "top" : "bottom";
}

/** Group text items into visual lines (top→bottom, left→right within a line). */
export function itemsToLines(items: TextItem[]): string[] {
  const sorted = [...items].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2 || a.x0 - b.x0);
  const lines: { cy: number; parts: TextItem[] }[] = [];
  for (const item of sorted) {
    const cy = (item.y0 + item.y1) / 2;
    const current = lines[lines.length - 1];
    if (current && Math.abs(current.cy - cy) <= SAME_LINE_TOLERANCE_PT) current.parts.push(item);
    else lines.push({ cy, parts: [item] });
  }
  return lines
    .map((line) =>
      line.parts
        .sort((a, b) => a.x0 - b.x0)
        .map((part) => part.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
}
