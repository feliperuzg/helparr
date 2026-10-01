import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireSession } from '@/server/auth/guard';
import { explainCandidate } from '@/server/decisions/explain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One candidate's comparison against the file on disk (REQ-DEC-001..008,
 * ADR-10, ADR-12).
 *
 * A POST only because the candidate travels in the body; nothing upstream is
 * written. The candidate is the instance's own evaluation the screen already
 * holds — a queue record's, a gap's evaluated release, or a search result's —
 * so this costs the config cache plus at most one file read, never a search.
 *
 * Always 200 with `{ ok }` for an instance that cannot be read: REQ-DEC-008
 * says the verbatim rejection still renders, and the failure body carries it.
 */

const qualitySchema = z.object({
  quality: z.object({
    id: z.number(),
    name: z.string(),
    source: z.string().optional(),
    resolution: z.number().optional(),
  }).passthrough(),
  revision: z.object({
    version: z.number(),
    real: z.number(),
    isRepack: z.boolean(),
  }).passthrough(),
}).passthrough();

const explainSchema = z.object({
  instanceId: z.string().min(1).max(256),
  episodeId: z.number().int().positive().optional(),
  movieId: z.number().int().positive().optional(),
  fileId: z.number().int().positive().nullable(),
  profileId: z.number().int().nonnegative(),
  candidate: z.object({
    title: z.string().max(2048),
    infoHash: z.string().max(256).nullable(),
    guid: z.string().max(4096).nullable(),
    rejections: z.array(z.string().max(4096)).max(100),
    quality: qualitySchema.nullable(),
    customFormats: z.array(z.object({ id: z.number(), name: z.string().max(256) })).max(200),
    customFormatScore: z.number().nullable(),
    episodeIds: z.array(z.number().int()).max(500),
    movieId: z.number().int().nullable(),
    indexer: z.string().max(256).nullable(),
  }).strict(),
}).strict();

export async function POST(request: Request) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  let input: z.infer<typeof explainSchema>;
  try {
    input = explainSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid explain request.' }, { status: 400 });
  }

  const { instanceId, ...target } = input;
  const result = await explainCandidate(instanceId, target, request.signal);

  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
