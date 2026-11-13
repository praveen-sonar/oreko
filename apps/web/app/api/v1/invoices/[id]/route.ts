import { NextRequest } from 'next/server';
import { prisma } from '@oreko/database';
import { authenticateApiRequest, apiSuccess, apiError } from '@/lib/api/auth';
import { toNumber } from '@/lib/utils';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatInvoice(inv: Record<string, any>) {
  return {
    id: inv.id as string,
    invoiceNumber: inv.invoiceNumber as string,
    title: inv.title as string,
    status: inv.status as string,
    client: inv.client as { id: string; name: string; email: string; company: string | null } | null,
    currency: inv.currency as string,
    issueDate: inv.issueDate as Date,
    dueDate: inv.dueDate as Date,
    subtotal: toNumber(inv.subtotal),
    discountType: inv.discountType as string | null,
    discountValue: inv.discountValue ? toNumber(inv.discountValue) : null,
    discountAmount: toNumber(inv.discountAmount),
    taxTotal: toNumber(inv.taxTotal),
    total: toNumber(inv.total),
    amountPaid: toNumber(inv.amountPaid),
    amountDue: toNumber(inv.amountDue),
    notes: inv.notes as string | null,
    terms: inv.terms as string | null,
    sentAt: inv.sentAt as Date | null,
    paidAt: inv.paidAt as Date | null,
    voidedAt: inv.voidedAt as Date | null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lineItems: inv.lineItems?.map((li: any) => ({
      id: li.id as string,
      name: li.name as string,
      description: li.description as string | null,
      quantity: toNumber(li.quantity),
      rate: toNumber(li.rate),
      amount: toNumber(li.amount),
      taxRate: li.taxRate ? toNumber(li.taxRate) : null,
      taxAmount: toNumber(li.taxAmount),
    })),
    createdAt: inv.createdAt as Date,
    updatedAt: inv.updatedAt as Date,
  };
}

interface LineItemInput {
  name: string;
  description?: string;
  quantity: number;
  rate: number;
  taxRate?: number;
}

interface PatchBody {
  title?: string;
  notes?: string;
  terms?: string;
  dueDate?: string;
  status?: string;
  lineItems?: LineItemInput[];
}

const IMMUTABLE_STATUSES = new Set(['paid', 'voided']);

const VALID_TRANSITIONS: Record<string, string[]> = {
  draft: ['sent'],
  sent: ['viewed', 'partial', 'paid', 'overdue', 'voided'],
  viewed: ['partial', 'paid', 'overdue', 'voided'],
  partial: ['paid', 'voided'],
  paid: ['voided'],
  overdue: ['paid', 'partial', 'voided'],
  voided: [],
};

const INVOICE_INCLUDE = {
  client: { select: { id: true, name: true, email: true, company: true } },
  lineItems: { orderBy: { sortOrder: 'asc' as const } },
};

/**
 * Applies simple field updates to updateData. Returns an error message or null when valid.
 */
function applyFieldUpdates(body: PatchBody, updateData: Record<string, unknown>): string | null {
  const { title, notes, terms, dueDate } = body;
  if (title !== undefined) updateData.title = title;
  if (notes !== undefined) updateData.notes = notes;
  if (terms !== undefined) updateData.terms = terms;
  if (dueDate === undefined) return null;
  if (Number.isNaN(new Date(dueDate).getTime())) return 'Invalid due date';
  updateData.dueDate = new Date(dueDate);
  return null;
}

function hasNonStatusChanges(body: PatchBody): boolean {
  return [body.title, body.notes, body.terms, body.dueDate, body.lineItems].some(
    (value) => value !== undefined
  );
}

/**
 * Validates the status transition and applies status-related fields to updateData.
 * Returns an error message if the transition is invalid, otherwise null.
 */
function applyStatusTransition(
  invoice: { status: string; paidAt: Date | null },
  status: string | undefined,
  updateData: Record<string, unknown>
): string | null {
  if (status === undefined) return null;
  const allowed = VALID_TRANSITIONS[invoice.status];
  if (!allowed || !allowed.includes(status)) {
    return 'Invalid status transition';
  }
  updateData.status = status;
  if ((status === 'paid' || status === 'partial') && !invoice.paidAt) updateData.paidAt = new Date();
  if (status === 'voided') updateData.voidedAt = new Date();
  if (status === 'sent') updateData.sentAt = new Date();
  return null;
}

function validateLineItem(item: LineItemInput): string | null {
  // Bug #41: Validate line item name is non-empty
  if (!item.name || typeof item.name !== 'string' || !item.name.trim()) {
    return 'Line item name is required';
  }
  if (!Number.isFinite(item.quantity) || !Number.isFinite(item.rate)) {
    return 'Line item quantity and rate must be valid numbers';
  }
  if (item.quantity < 0) return 'Line item quantity cannot be negative';
  if (item.rate < 0) return 'Line item rate cannot be negative';
  // Bug #40: Upper bound on rate and quantity
  if (item.quantity > 1_000_000) return 'Line item quantity must be at most 1,000,000';
  if (item.rate > 1_000_000) return 'Line item rate must be at most 1,000,000';
  if (item.taxRate !== undefined && item.taxRate !== null && !Number.isFinite(item.taxRate)) {
    return 'Line item taxRate must be a valid number';
  }
  return null;
}

/**
 * Validates line items for an invoice. Returns an error message or null when valid.
 */
function validateLineItems(invoiceStatus: string, lineItems: LineItemInput[]): string | null {
  // Block financial changes on paid/voided invoices
  if (IMMUTABLE_STATUSES.has(invoiceStatus)) {
    return `Cannot modify line items on a ${invoiceStatus} invoice`;
  }

  // Bug #36: Limit line item count
  if (lineItems.length > 100) {
    return 'Maximum 100 line items allowed';
  }

  for (const item of lineItems) {
    const error = validateLineItem(item);
    if (error) return error;
  }
  return null;
}

function processLineItems(invoiceId: string, lineItems: LineItemInput[]) {
  let subtotal = 0;
  let taxTotal = 0;
  const processed = lineItems.map((item, i) => {
    const amount = Math.round(item.quantity * item.rate * 100) / 100;
    const taxAmount = item.taxRate ? Math.round(amount * (item.taxRate / 100) * 100) / 100 : 0;
    subtotal += amount;
    taxTotal += taxAmount;
    return {
      invoiceId,
      name: item.name,
      description: item.description || null,
      quantity: item.quantity,
      rate: item.rate,
      amount,
      taxRate: item.taxRate ?? null,
      taxAmount,
      sortOrder: i,
    };
  });
  return { processed, subtotal, taxTotal };
}

function computeDiscountAmount(
  invoice: { discountType: unknown; discountValue: Parameters<typeof toNumber>[0] },
  subtotal: number
): number {
  const discountType = invoice.discountType as string | null;
  const discountValue = invoice.discountValue ? toNumber(invoice.discountValue) : 0;
  if (discountValue <= 0) return 0;
  if (discountType === 'percentage') {
    return Math.round(subtotal * (discountValue / 100) * 100) / 100;
  }
  if (discountType === 'fixed') {
    return Math.min(discountValue, subtotal);
  }
  return 0;
}

async function updateWithLineItems(
  id: string,
  invoice: { discountType: unknown; discountValue: Parameters<typeof toNumber>[0] },
  lineItems: LineItemInput[],
  updateData: Record<string, unknown>
) {
  const { processed, subtotal, taxTotal } = processLineItems(id, lineItems);

  // Recalculate with existing discount fields
  const discountAmount = computeDiscountAmount(invoice, subtotal);

  const total = subtotal - discountAmount + taxTotal;
  updateData.subtotal = subtotal;
  updateData.taxTotal = taxTotal;
  updateData.discountAmount = discountAmount;
  updateData.total = total;
  // Use fresh amountPaid from DB to avoid stale data
  const freshInvoice = await prisma.invoice.findUnique({ where: { id }, select: { amountPaid: true } });
  updateData.amountDue = Math.max(0, total - toNumber(freshInvoice?.amountPaid));

  // Include line item replacement and totals update in same transaction
  return prisma.$transaction(async (tx) => {
    await tx.invoiceLineItem.deleteMany({ where: { invoiceId: id } });
    await tx.invoiceLineItem.createMany({ data: processed });
    return tx.invoice.update({
      where: { id },
      data: updateData,
      include: INVOICE_INCLUDE,
    });
  });
}

// GET /api/v1/invoices/:id
export async function GET(request: NextRequest, { params }: RouteParams) {
  const auth = await authenticateApiRequest(request);
  if ('error' in auth) return auth.error;
  const { workspaceId } = auth.context;
  const { id } = await params;

  const invoice = await prisma.invoice.findFirst({
    where: { id, workspaceId, deletedAt: null },
    include: {
      client: { select: { id: true, name: true, email: true, company: true } },
      lineItems: { orderBy: { sortOrder: 'asc' } },
    },
  });

  if (!invoice) return apiError('Invoice not found', 404);
  return apiSuccess(formatInvoice(invoice));
}

// PATCH /api/v1/invoices/:id
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const auth = await authenticateApiRequest(request);
  if ('error' in auth) return auth.error;
  const { workspaceId } = auth.context;
  const { id } = await params;

  const invoice = await prisma.invoice.findFirst({
    where: { id, workspaceId, deletedAt: null },
  });
  if (!invoice) return apiError('Invoice not found', 404);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError('Invalid JSON body', 400);
  }

  // Strip potentially dangerous fields that should never be user-controlled
  delete body.id;
  delete body.workspaceId;
  delete body.deletedAt;
  delete body.createdAt;
  delete body.updatedAt;
  // Bug #173: invoiceNumber and amountPaid are system-controlled
  delete body.invoiceNumber;
  delete body.amountPaid;

  const patch = body as PatchBody;
  const { status, lineItems } = patch;

  const updateData: Record<string, unknown> = {};
  const fieldError = applyFieldUpdates(patch, updateData);
  if (fieldError) return apiError(fieldError, 400);

  // Bug #30: Paid/voided invoices should not allow ANY changes (except status transitions)
  if (IMMUTABLE_STATUSES.has(invoice.status) && hasNonStatusChanges(patch)) {
    return apiError('Cannot modify a paid or voided invoice', 400);
  }

  const statusError = applyStatusTransition(invoice, status, updateData);
  if (statusError) return apiError(statusError, 400);

  if (lineItems) {
    const lineItemsError = validateLineItems(invoice.status, lineItems);
    if (lineItemsError) return apiError(lineItemsError, 400);
  }

  const updated = lineItems
    ? await updateWithLineItems(id, invoice, lineItems, updateData)
    : await prisma.invoice.update({
        where: { id },
        data: updateData,
        include: INVOICE_INCLUDE,
      });

  // Bug #188: Create audit event for v1 API updates
  await prisma.invoiceEvent.create({
    data: { invoiceId: id, eventType: 'updated', actorType: 'system', metadata: { via: 'api' } }
  }).catch(() => {});

  return apiSuccess(formatInvoice(updated));
}

// DELETE /api/v1/invoices/:id
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const auth = await authenticateApiRequest(request);
  if ('error' in auth) return auth.error;
  const { workspaceId } = auth.context;
  const { id } = await params;

  const invoice = await prisma.invoice.findFirst({
    where: { id, workspaceId, deletedAt: null },
  });
  if (!invoice) return apiError('Invoice not found', 404);

  // Prevent deletion of paid or partially paid invoices
  if (['paid', 'partial'].includes(invoice.status)) {
    return apiError(`Cannot delete a ${invoice.status} invoice. Void it instead.`, 400);
  }

  await prisma.invoice.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  return apiSuccess({ message: 'Invoice deleted' });
}
