import { NextRequest } from 'next/server';
import { prisma } from '@oreko/database';
import { authenticateApiRequest, apiSuccess, apiError } from '@/lib/api/auth';
import { logger } from '@/lib/logger';

type ImportClientRow = {
  name: string;
  email: string;
  phone?: string;
  company?: string;
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
};

type ImportResult = {
  success: number;
  failed: number;
  skipped: number;
  errors: Array<{ row: number; message: string }>;
  created: Array<{ id: string; name: string; email: string }>;
};

type ValidRow = { index: number; row: ImportClientRow };

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function loadExistingEmails(
  workspaceId: string,
  clients: ImportClientRow[]
): Promise<Set<string>> {
  const existingClients = await prisma.client.findMany({
    where: {
      workspaceId,
      email: { in: clients.map((r) => r.email).filter(Boolean) },
      deletedAt: null,
    },
    select: { email: true },
  });
  return new Set(existingClients.map((c) => c.email.toLowerCase()));
}

function getRowError(row: ImportClientRow): string | null {
  if (!row.name || typeof row.name !== 'string' || row.name.trim().length === 0) {
    return 'name is required';
  }
  if (!row.email || !EMAIL_REGEX.test(row.email)) {
    return 'Invalid email format';
  }
  return null;
}

function validateRows(
  clients: ImportClientRow[],
  existingEmailSet: Set<string>,
  result: ImportResult
): ValidRow[] {
  const validRows: ValidRow[] = [];

  clients.forEach((row, i) => {
    // Validate required fields
    const error = getRowError(row);
    if (error) {
      result.failed++;
      result.errors.push({ row: i + 1, message: error });
      return;
    }

    // Check for duplicates (existing clients or within the import batch itself)
    const email = row.email.toLowerCase();
    if (existingEmailSet.has(email)) {
      result.skipped++;
      return;
    }

    existingEmailSet.add(email);
    validRows.push({ index: i, row });
  });

  return validRows;
}

function buildClientCreate(workspaceId: string, row: ImportClientRow) {
  // Build address if any address fields provided
  let address: Record<string, string | undefined> | undefined;
  if (row.street || row.city || row.state || row.postalCode || row.country) {
    address = {
      street: row.street,
      city: row.city,
      state: row.state,
      postalCode: row.postalCode,
      country: row.country,
    };
  }

  const metadata = {
    type: row.company ? 'company' : 'individual',
    contacts: [],
    tags: [],
  };

  return prisma.client.create({
    data: {
      workspaceId,
      name: row.name.trim(),
      email: row.email.trim().toLowerCase(),
      phone: row.phone || null,
      company: row.company || null,
      address: (address || undefined) as any,
      metadata: metadata as any,
    },
  });
}

async function createClients(
  workspaceId: string,
  validRows: ValidRow[],
  result: ImportResult
): Promise<void> {
  try {
    const createdClients = await prisma.$transaction(
      validRows.map(({ row }) => buildClientCreate(workspaceId, row))
    );

    for (const client of createdClients) {
      result.success++;
      result.created.push({ id: client.id, name: client.name, email: client.email });
    }
  } catch (err: any) {
    // If transaction fails, all rows fail
    const message = err?.code === 'P2002' ? 'Duplicate email' : 'Failed to create client';
    for (const { index } of validRows) {
      result.failed++;
      result.errors.push({ row: index + 1, message });
    }
  }
}

// POST /api/v1/clients/import — Bulk import clients from a JSON array
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticateApiRequest(request);
    if ('error' in auth) return auth.error;
    const { workspaceId } = auth.context;

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return apiError('Invalid JSON body', 400);
    }

    const { clients, skipDuplicates = true } = body as {
      clients?: ImportClientRow[];
      skipDuplicates?: boolean;
    };

    if (!clients || !Array.isArray(clients)) {
      return apiError('clients array is required', 400);
    }

    if (clients.length === 0) {
      return apiError('clients array cannot be empty', 400);
    }

    if (clients.length > 500) {
      return apiError('Maximum 500 clients per import', 400);
    }

    const result: ImportResult = {
      success: 0,
      failed: 0,
      skipped: 0,
      errors: [],
      created: [],
    };

    // Batch duplicate check
    const existingEmailSet = skipDuplicates
      ? await loadExistingEmails(workspaceId, clients)
      : new Set<string>();

    // Pre-validate all rows before the transaction
    const validRows = validateRows(clients, existingEmailSet, result);

    // Wrap all client creations in a transaction for atomicity
    if (validRows.length > 0) {
      await createClients(workspaceId, validRows, result);
    }

    return apiSuccess({
      message: `Import complete: ${result.success} created, ${result.skipped} skipped, ${result.failed} failed`,
      ...result,
    }, 201);
  } catch (err) {
    logger.error({ err }, 'Client import API error');
    return apiError('Internal server error', 500);
  }
}
