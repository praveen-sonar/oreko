/**
 * One-time production data cleanup script
 * Fixes corrupted workspace names, user names, and quote/invoice amounts
 * that were changed during manual testing.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function fixTestUser() {
  // 1. Fix corrupted user name for test@oreko.dev
  const testUser = await prisma.user.findUnique({ where: { email: 'test@oreko.dev' } });
  if (!testUser) {
    return testUser;
  }
  if (testUser.name !== 'Test User') {
    await prisma.user.update({
      where: { id: testUser.id },
      data: { name: 'Test User' },
    });
    console.log(`Fixed user name: "${testUser.name}" -> "Test User"`);
  } else {
    console.log('User name already correct: Test User');
  }
  return testUser;
}

async function findCorruptedWorkspace(userId: string | undefined) {
  // 2. Fix corrupted workspace name and slug
  // Find the workspace the test user belongs to (not 'test-workspace' which is a new one)
  const testUserMemberships = await prisma.workspaceMember.findMany({
    where: { userId },
    include: { workspace: true },
  });

  console.log(`\nUser workspaces (${testUserMemberships.length}):`);
  for (const m of testUserMemberships) {
    console.log(`  - "${m.workspace.name}" (slug: ${m.workspace.slug}, role: ${m.role})`);
  }

  // Find the corrupted workspace (the one that's NOT 'test-workspace')
  return testUserMemberships.find(
    (m) => m.workspace.slug !== 'test-workspace' && m.workspace.slug !== 'demo-workspace'
  );
}

type AmountUpdate = { title: string; subtotal: number };

type QuoteRecord = { id: string; quoteNumber: string; title: string | null; total: unknown };

type InvoiceRecord = {
  id: string;
  invoiceNumber: string;
  title: string | null;
  total: unknown;
  status: string;
};

const QUOTE_UPDATES: Record<string, AmountUpdate> = {
  'Q-0001': { title: 'Website Revamp', subtotal: 2500 },
  'Q-0002': { title: 'API Integration Project', subtotal: 5750 },
  'Q-0003': { title: 'Mobile App Design', subtotal: 8400 },
  'Q-0004': { title: 'E-commerce Platform', subtotal: 15000 },
  'Q-0005': { title: 'Data Migration Service', subtotal: 3200 },
  'Q-0006': { title: 'SaaS Dashboard Build', subtotal: 12800 },
};

const INVOICE_UPDATES: Record<string, AmountUpdate> = {
  'INV-0100': { title: 'Server Setup & Config', subtotal: 1200 },
  'INV-0101': { title: 'Q1 Consulting Retainer', subtotal: 3800 },
  'INV-0102': { title: 'Design System Delivery', subtotal: 6500 },
  'INV-0103': { title: 'Landing Page Build', subtotal: 4200 },
  'INV-0104': { title: 'Database Optimization', subtotal: 2750 },
  'INV-0105': { title: 'Cancelled Project Deposit', subtotal: 950 },
  'INV-0006': { title: 'SaaS Dashboard Build - Invoice', subtotal: 12800 },
};

async function fixQuote(q: QuoteRecord): Promise<string> {
  const update = QUOTE_UPDATES[q.quoteNumber];
  if (!update) {
    return `  ${q.quoteNumber}: "${q.title}" $${q.total} (no update needed)`;
  }

  await prisma.quote.update({
    where: { id: q.id },
    data: { title: update.title, subtotal: update.subtotal, total: update.subtotal },
  });

  // Update line items too
  const items = await prisma.quoteLineItem.findMany({ where: { quoteId: q.id } });
  if (items.length > 0) {
    await prisma.quoteLineItem.update({
      where: { id: items[0]!.id },
      data: { amount: update.subtotal },
    });
  }

  return `  ${q.quoteNumber}: "$${q.total}" -> "$${update.subtotal}" (${update.title})`;
}

async function fixQuotes(workspaceId: string) {
  // 3. Fix quote titles and amounts in this workspace
  const quotes = await prisma.quote.findMany({
    where: { workspaceId },
    orderBy: { quoteNumber: 'asc' },
  });

  console.log(`\nQuotes in workspace (${quotes.length}):`);
  const messages = await Promise.all(quotes.map((q) => fixQuote(q)));
  messages.forEach((message) => console.log(message));
}

async function fixInvoice(inv: InvoiceRecord): Promise<string> {
  const update = INVOICE_UPDATES[inv.invoiceNumber];
  if (!update) {
    return `  ${inv.invoiceNumber}: "${inv.title}" $${inv.total} (no update defined)`;
  }

  const isPaid = inv.status === 'paid';
  await prisma.invoice.update({
    where: { id: inv.id },
    data: {
      title: update.title,
      subtotal: update.subtotal,
      total: update.subtotal,
      amountPaid: isPaid ? update.subtotal : 0,
      amountDue: isPaid ? 0 : update.subtotal,
    },
  });

  // Update line items too
  const items = await prisma.invoiceLineItem.findMany({ where: { invoiceId: inv.id } });
  if (items.length > 0) {
    await prisma.invoiceLineItem.update({
      where: { id: items[0]!.id },
      data: { amount: update.subtotal },
    });
  }

  return `  ${inv.invoiceNumber}: "$${inv.total}" -> "$${update.subtotal}" (${update.title})`;
}

async function fixInvoices(workspaceId: string) {
  // 4. Fix invoice titles and amounts in this workspace
  const invoices = await prisma.invoice.findMany({
    where: { workspaceId },
    orderBy: { invoiceNumber: 'asc' },
  });

  console.log(`\nInvoices in workspace (${invoices.length}):`);
  const messages = await Promise.all(invoices.map((inv) => fixInvoice(inv)));
  messages.forEach((message) => console.log(message));
}

async function cleanupExtraWorkspace(keepWorkspaceId: string) {
  // 5. Clean up the extra 'test-workspace' that was created by the seed
  const extraWorkspace = await prisma.workspace.findUnique({ where: { slug: 'test-workspace' } });
  if (!extraWorkspace || extraWorkspace.id === keepWorkspaceId) {
    return;
  }
  // Remove members, then the workspace
  await prisma.workspaceMember.deleteMany({ where: { workspaceId: extraWorkspace.id } });
  await prisma.businessProfile.deleteMany({ where: { workspaceId: extraWorkspace.id } });
  await prisma.numberSequence.deleteMany({ where: { workspaceId: extraWorkspace.id } });
  // Check for quotes/invoices (should be none if the data was in the corrupted workspace)
  const extraQuotes = await prisma.quote.count({ where: { workspaceId: extraWorkspace.id } });
  const extraInvoices = await prisma.invoice.count({ where: { workspaceId: extraWorkspace.id } });
  if (extraQuotes === 0 && extraInvoices === 0) {
    await prisma.rateCard.deleteMany({ where: { workspaceId: extraWorkspace.id } });
    await prisma.rateCardCategory.deleteMany({ where: { workspaceId: extraWorkspace.id } });
    await prisma.client.deleteMany({ where: { workspaceId: extraWorkspace.id } });
    await prisma.workspace.delete({ where: { id: extraWorkspace.id } });
    console.log(`\nCleaned up extra workspace: "test-workspace" (id: ${extraWorkspace.id})`);
  } else {
    console.log(
      `\nExtra workspace "test-workspace" has ${extraQuotes} quotes and ${extraInvoices} invoices - skipping cleanup`
    );
  }
}

async function fixCorruptedWorkspace(ws: { id: string; name: string; slug: string }) {
  console.log(`\nFixing workspace: "${ws.name}" (slug: ${ws.slug})`);

  // Update the workspace name (keep the slug as-is to avoid breaking things)
  await prisma.workspace.update({
    where: { id: ws.id },
    data: { name: 'Test Workspace' },
  });
  console.log(`  Updated name: "${ws.name}" -> "Test Workspace"`);

  await fixQuotes(ws.id);
  await fixInvoices(ws.id);
  await cleanupExtraWorkspace(ws.id);
}

async function fixDemoData() {
  // 6. Fix demo user name
  const demoUser = await prisma.user.findUnique({ where: { email: 'demo@oreko.demo' } });
  if (demoUser && demoUser.name !== 'Demo User') {
    await prisma.user.update({
      where: { id: demoUser.id },
      data: { name: 'Demo User' },
    });
    console.log(`\nFixed demo user name: "${demoUser.name}" -> "Demo User"`);
  }

  // 7. Fix demo workspace name
  const demoWorkspace = await prisma.workspace.findUnique({ where: { slug: 'demo-workspace' } });
  if (demoWorkspace && demoWorkspace.name !== 'Demo Workspace') {
    await prisma.workspace.update({
      where: { id: demoWorkspace.id },
      data: { name: 'Demo Workspace' },
    });
    console.log(`Fixed demo workspace name: "${demoWorkspace.name}" -> "Demo Workspace"`);
  }
}

async function main() {
  console.log('Starting production data cleanup...\n');

  const testUser = await fixTestUser();
  const corruptedWorkspace = await findCorruptedWorkspace(testUser?.id);

  if (corruptedWorkspace) {
    await fixCorruptedWorkspace(corruptedWorkspace.workspace);
  } else {
    console.log(
      '\nNo corrupted workspace found (test user only in test-workspace and/or demo-workspace)'
    );
  }

  await fixDemoData();

  console.log('\nProduction data cleanup completed!');
}

main()
  .catch((e) => {
    console.error('Error during cleanup:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
