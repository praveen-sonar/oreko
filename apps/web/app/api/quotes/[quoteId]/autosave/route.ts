import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@oreko/database';
import { getCurrentUserWorkspace } from '@/lib/workspace/get-current-workspace';
import { checkRateLimit, getRateLimitHeaders } from '@/lib/rate-limit';
import { validateRequestOrigin } from '@/lib/csrf';

const MAX_BLOCKS = 200;
// 500KB
const MAX_BLOCKS_SIZE = 500000;

function buildTextFieldUpdates(body: Record<string, unknown>): Record<string, unknown> {
  const updateData: Record<string, unknown> = {};
  if (typeof body.title === 'string' && body.title.trim()) {
    updateData.title = body.title.slice(0, 500);
  }
  if (typeof body.notes === 'string') {
    updateData.notes = body.notes.slice(0, 10000);
  }
  if (typeof body.terms === 'string') {
    updateData.terms = body.terms.slice(0, 10000);
  }
  if (typeof body.internalNotes === 'string') {
    updateData.internalNotes = body.internalNotes.slice(0, 10000);
  }
  return updateData;
}

function isValidBlock(block: unknown): boolean {
  return (
    typeof block === 'object' &&
    block !== null &&
    typeof (block as Record<string, unknown>).id === 'string' &&
    typeof (block as Record<string, unknown>).type === 'string'
  );
}

/**
 * Returns an error message if the blocks array is invalid, otherwise null.
 */
function validateBlocks(blocks: unknown[]): string | null {
  // Limit blocks array size to prevent abuse
  if (blocks.length > MAX_BLOCKS) {
    return 'Too many blocks (max 200)';
  }
  // Limit total JSON size
  if (JSON.stringify(blocks).length > MAX_BLOCKS_SIZE) {
    return 'Blocks data too large (max 500KB)';
  }
  // MEDIUM #4: Basic shape validation for blocks array
  if (!blocks.every(isValidBlock)) {
    return 'Invalid blocks format: each block must have id and type';
  }
  return null;
}

function mergeBlocksIntoSettings(settings: unknown, blocks: unknown[]): Record<string, unknown> {
  const existingSettings =
    typeof settings === 'object' && settings !== null ? (settings as Record<string, unknown>) : {};
  return { ...existingSettings, blocks };
}

/**
 * POST /api/quotes/[quoteId]/autosave
 * Bug #206: Lightweight endpoint for navigator.sendBeacon auto-save on page unload.
 * Accepts a JSON body with quote fields to update.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ quoteId: string }> }
) {
  try {
    // MEDIUM #5: CSRF protection on autosave
    if (!validateRequestOrigin(request)) {
      return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
    }
    const { quoteId } = await params;
    if (!quoteId || typeof quoteId !== 'string') {
      return NextResponse.json({ error: 'Invalid quote ID' }, { status: 400 });
    }

    let workspaceId: string;
    let userId: string;
    try {
      const result = await getCurrentUserWorkspace();
      workspaceId = result.workspaceId;
      userId = result.userId;
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // MEDIUM #3: Rate limit autosave to prevent abuse
    const rateLimitResult = await checkRateLimit(`autosave:${userId}:${quoteId}`, {
      limit: 30,
      windowMs: 60000, // 30 saves per minute per user per quote
    });
    if (rateLimitResult.limited) {
      return NextResponse.json(
        { error: 'Too many autosave requests' },
        { status: 429, headers: getRateLimitHeaders(rateLimitResult) }
      );
    }

    const body = await request.json();

    // Validate the quote belongs to this workspace
    const quote = await prisma.quote.findFirst({
      where: { id: quoteId, workspaceId, deletedAt: null },
      select: { id: true, settings: true },
    });

    if (!quote) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
    }

    // Only update allowed fields
    const updateData = buildTextFieldUpdates(body);
    if (Array.isArray(body.blocks)) {
      const blocksError = validateBlocks(body.blocks);
      if (blocksError) {
        return NextResponse.json({ error: blocksError }, { status: 400 });
      }
      updateData.settings = mergeBlocksIntoSettings(quote.settings, body.blocks);
    }

    if (Object.keys(updateData).length > 0) {
      await prisma.quote.update({
        where: { id: quoteId },
        data: updateData,
      });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Auto-save failed' }, { status: 500 });
  }
}
