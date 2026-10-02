import 'server-only';

import { z } from 'zod';

/**
 * The force-import row-edit PATCH body (`api/import/plan/[id]`), kept out of
 * the route file because a route module may only export HTTP handlers and
 * segment config — `next build` rejects any other export — and the strict
 * union is worth pinning in the node lane on its own.
 */

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

const singleRowSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  included: z.boolean().optional(),
  mapping: mappingSchema.optional(),
}).strict();

/**
 * The bulk arm (ADR-6, REQ-QUEUE-025): "Include all" / "Exclude all" /
 * "Include all replacements" and range inclusion all post this shape, naming
 * every ordinal to set in one request rather than one PATCH per row. Unlike
 * `singleRowSchema` it never carries a `mapping` — a bulk edit only ever
 * flips `included`. Both arms are `.strict()`, so a body carrying fields from
 * both (or neither) matches neither arm and is a 400, never silently
 * coerced into one.
 */
const bulkSchema = z.object({
  ordinals: z.array(z.number().int().nonnegative()).min(1).max(5000),
  included: z.boolean(),
}).strict().refine(
  (body) => new Set(body.ordinals).size === body.ordinals.length,
  { message: 'Duplicate ordinals.' },
);

export const patchSchema = z.union([singleRowSchema, bulkSchema]);

export type ImportRowPatch = z.infer<typeof patchSchema>;
