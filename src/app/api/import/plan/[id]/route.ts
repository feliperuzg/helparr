import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { ImportMapping } from '@/lib/importPlan';
import { requireSession } from '@/server/auth/guard';
import { editImportRow, type EditImportRowError } from '@/server/import/build';
import { getImportPlan } from '@/server/import/store';
import { isImporting } from '@/server/import/apply';
import { importWriteEnabled } from '@/server/import/kinds';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * The plan, whole, on every read (ADR-3, T11) — same role `rename/plan/[id]`
 * plays for rename. `importing` is carried alongside the plan rather than
 * folded into `phase`, because `phase` already distinguishes `applying`;
 * `importing` is `startImport`'s own in-flight marker (`apply.ts`'s `inFlight`
 * set), kept separate so a poll can tell "the DB says applying" from "the run
 * that got it there is still this process's own" without inferring one from
 * the other.
 *
 * `writeEnabled` is the server's own per-kind gate (`kinds.ts`, ADR-6), sent so
 * the screen hides the write controls on the same flag `startImport` enforces
 * rather than re-deriving it from the instance kind.
 */
export async function GET(_request: Request, { params }: Params) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const { id } = await params;
  const plan = getImportPlan(id);
  if (!plan) {
    return NextResponse.json({ error: 'No such force-import plan.' }, { status: 404 });
  }

  return NextResponse.json(
    { ...plan, importing: isImporting(id), writeEnabled: importWriteEnabled(plan.instanceKind) },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}

const seriesMappingSchema = z.object({
  kind: z.literal('series'),
  seriesId: z.number().int().positive(),
  seriesTitle: z.string().nullable(),
  seasonNumber: z.number().int(),
  episodeIds: z.array(z.number().int()),
  label: z.string().min(1).max(512),
}).strict();

const movieMappingSchema = z.object({
  kind: z.literal('movie'),
  movieId: z.number().int().positive(),
  label: z.string().min(1).max(512),
}).strict();

// Mirrors `ImportMapping` (`lib/importPlan.ts`) field for field — a mapping
// override must be one of exactly these two shapes, each `.strict()`.
const mappingSchema = z.discriminatedUnion('kind', [seriesMappingSchema, movieMappingSchema]);

const patchSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  included: z.boolean().optional(),
  mapping: mappingSchema.optional(),
}).strict();

const EDIT_STATUS: Record<EditImportRowError, number> = {
  // The plan itself does not exist, or exists but has left `ready` — named
  // distinctly from a missing row (ADR-3's TTL and `startImport`'s own guard
  // against a concurrent apply).
  'plan-not-ready': 409,
  'row-not-found': 404,
  // Included with no mapping at all — a well-formed request the row simply
  // cannot satisfy yet (`store.ts`'s `updateImportRow`).
  'missing-mapping': 400,
  // The override does not resolve — wrong series, an episode outside it, or
  // the instance could not be re-read (`build.ts`'s `editImportRow`).
  'invalid-mapping': 400,
  // Radarr's movie is fixed in this change (ADR-4) — there is no second movie
  // to offer, so an override is refused outright.
  'radarr-mapping-fixed': 409,
};

/**
 * One row edit — include/exclude or a mapping override (ADR-4, FR7, T11).
 *
 * `ordinal` names the row; there is no file path or mapping id a caller could
 * use to touch a row this plan does not contain, because `editImportRow`
 * resolves everything else (the series a Sonarr override must stay inside,
 * the episode ids it must belong to) by re-reading the plan and the instance
 * — never by trusting what the request asserts beyond `ordinal` and the
 * literal fields of `ImportMapping`.
 */
export async function PATCH(request: Request, { params }: Params) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const { id } = await params;

  let input: z.infer<typeof patchSchema>;
  try {
    input = patchSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid row edit.' }, { status: 400 });
  }

  if (!getImportPlan(id)) {
    return NextResponse.json({ error: 'No such force-import plan.' }, { status: 404 });
  }

  const patch: { included?: boolean; mapping?: ImportMapping } = {
    included: input.included,
    mapping: input.mapping,
  };

  const result = await editImportRow(id, input.ordinal, patch, request.signal);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: EDIT_STATUS[result.error] },
    );
  }

  const plan = getImportPlan(id);
  if (!plan) {
    return NextResponse.json({ error: 'No such force-import plan.' }, { status: 404 });
  }

  return NextResponse.json(
    { ...plan, importing: isImporting(id), writeEnabled: importWriteEnabled(plan.instanceKind) },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
