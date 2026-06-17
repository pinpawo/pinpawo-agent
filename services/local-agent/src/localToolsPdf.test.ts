import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { readFileTool } from './toolkits/local/fileTools';
import { pdfOperationMetadata, readPdfTool } from './toolkits/local/pdfTools';

function createFileFixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'pinpawo-pdf-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function escapePdfText(value: string) {
  return value.replace(/[\\()]/g, (match) => `\\${match}`);
}

function createPdfPageObject(pageObjectId: number, contentObjectId: number, fontObjectId: number) {
  return [
    `${pageObjectId} 0 obj`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`,
    'endobj',
    '',
  ].join('\n');
}

function createPdfContentObject(objectId: number, text: string) {
  const lines = text.split('\n');
  const stream = [
    'BT /F1 12 Tf 72 720 Td 14 TL',
    lines.map((line, index) => `${index === 0 ? '' : 'T* '}(${escapePdfText(line)}) Tj`).join('\n'),
    'ET',
  ].join('\n');
  return [
    `${objectId} 0 obj`,
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>`,
    'stream',
    stream,
    'endstream',
    'endobj',
    '',
  ].join('\n');
}

function createMinimalPdf(pages: string[]) {
  const fontObjectId = 3 + pages.length * 2;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    `2 0 obj\n<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>\nendobj\n`,
  ];

  pages.forEach((text, index) => {
    const pageObjectId = 3 + index * 2;
    const contentObjectId = pageObjectId + 1;
    objects.push(createPdfPageObject(pageObjectId, contentObjectId, fontObjectId));
    objects.push(createPdfContentObject(contentObjectId, text));
  });

  objects.push([
    `${fontObjectId} 0 obj`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    'endobj',
    '',
  ].join('\n'));

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += object;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(xrefOffset),
    '%%EOF',
    '',
  ].join('\n');

  return Buffer.from(pdf, 'ascii');
}

function readJsonOutput(output: unknown) {
  return JSON.parse(String(output)) as {
    ok: boolean;
    totalPages: number;
    startPage: number;
    endPage: number;
    truncated: boolean;
    pages: Array<{ page: number; text: string }>;
  };
}

test('read_pdf extracts text from a PDF page range', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'sample.pdf');
  writeFileSync(filePath, createMinimalPdf([
    'First PDF page',
    'Second PDF page',
  ]));

  const result = readJsonOutput(await readPdfTool.invoke({
    path: filePath,
    startPage: 2,
    endPage: 2,
  }));

  assert.equal(result.ok, true);
  assert.equal(result.totalPages, 2);
  assert.equal(result.startPage, 2);
  assert.equal(result.endPage, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.pages, [{ page: 2, text: 'Second PDF page' }]);
});

test('read_pdf truncates large output predictably', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'large.pdf');
  writeFileSync(filePath, createMinimalPdf([
    Array.from({ length: 150 }, (_, index) => `line ${index} has enough PDF text for truncation`).join('\n'),
  ]));

  const result = readJsonOutput(await readPdfTool.invoke({
    path: filePath,
    maxChars: 1_000,
  }));

  assert.equal(result.truncated, true);
  assert.equal(result.pages[0]?.text.length, 1_000);
});

test('read_file directs PDF callers to read_pdf', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'sample.pdf');
  writeFileSync(filePath, createMinimalPdf(['Use read_pdf']));

  const result = JSON.parse(String(await readFileTool.invoke({ path: filePath }))) as {
    ok: boolean;
    type: string;
    recommendation: string;
  };

  assert.equal(result.ok, false);
  assert.equal(result.type, 'pdf');
  assert.match(result.recommendation, /read_pdf/);
});

test('read_pdf has operation metadata', () => {
  const summary = pdfOperationMetadata.read_pdf?.summarizeInput?.({
    path: '/tmp/sample.pdf',
    startPage: 2,
    endPage: 4,
    maxChars: 5000,
  });

  assert.equal(pdfOperationMetadata.read_pdf?.title, '读PDF');
  assert.deepEqual(summary, {
    target: '/tmp/sample.pdf',
    details: {
      startPage: 2,
      endPage: 4,
      maxChars: 5000,
    },
  });
});
