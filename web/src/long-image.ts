import type { PublicQuoteDocument } from '../../shared/contracts.ts';
import { STATE_LABELS } from './format.ts';

const PAGE_WIDTH = 1125;
const PAGE_HEIGHT = 1800;
const MARGIN = 72;
const CONTENT_TOP = 112;
const CONTENT_BOTTOM = 90;

interface ImageRow {
  kind: 'text' | 'pair' | 'divider';
  height: number;
  value?: string;
  label?: string;
  size?: number;
  color?: string;
  bold?: boolean;
  indent?: number;
}

function wrap(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const output: string[] = [];
  for (const paragraph of text.replaceAll('\r', '').split('\n')) {
    if (!paragraph) {
      output.push('');
      continue;
    }
    let line = '';
    for (const character of [...paragraph]) {
      const next = line + character;
      if (line && context.measureText(next).width > maxWidth) {
        output.push(line);
        line = character;
      } else {
        line = next;
      }
    }
    if (line) output.push(line);
  }
  return output;
}

export function paginateRows<T extends { height: number }>(
  rows: T[],
  maximumHeight: number,
): T[][] {
  if (!Number.isFinite(maximumHeight) || maximumHeight <= 0) {
    throw new Error('分页高度必须大于 0');
  }
  const pages: T[][] = [];
  let page: T[] = [];
  let used = 0;
  for (const row of rows) {
    if (page.length > 0 && used + row.height > maximumHeight) {
      pages.push(page);
      page = [];
      used = 0;
    }
    page.push(row);
    used += row.height;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

function buildRows(quote: PublicQuoteDocument, context: CanvasRenderingContext2D): ImageRow[] {
  const rows: ImageRow[] = [];
  const addText = (value: string, size = 30, color = '#1b2523', bold = false, indent = 0) => {
    context.font = `${bold ? '600 ' : ''}${size}px "Microsoft YaHei", sans-serif`;
    for (const line of wrap(context, value, PAGE_WIDTH - MARGIN * 2 - indent)) {
      rows.push({
        kind: 'text',
        value: line,
        size,
        color,
        bold,
        indent,
        height: size + 20,
      });
    }
  };
  const addPair = (label: string, value: string, bold = false) => {
    rows.push({ kind: 'pair', label, value, bold, height: 54 });
  };
  const divider = () => rows.push({ kind: 'divider', height: 34 });

  addText('报价单', 52, '#0b6b5f', true);
  addText(quote.merchant.name, 36, '#1b2523', true);
  const contact = [
    quote.merchant.contactName,
    quote.merchant.contactPhone,
    quote.merchant.contactWechat ? `微信 ${quote.merchant.contactWechat}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  if (contact) addText(contact, 25, '#66726f');
  addText(`状态：${STATE_LABELS[quote.state]}`, 25, '#66726f');
  divider();
  addText(`报价编号：${quote.quoteNumber}`, 28);
  addText(`版本：V${quote.version} · 有效至：${quote.validUntil} 23:59`, 28);
  addText(`客户：${quote.customerName}`, 28);
  if (quote.projectName) addText(`项目：${quote.projectName}`, 28);
  if (quote.deliveryPeriod) addText(`交付周期：${quote.deliveryPeriod}`, 28);
  divider();

  quote.calculation.lines.forEach((line, index) => {
    addText(`${index + 1}. ${line.name}`, 32, '#1b2523', true);
    const detail = line.billableArea
      ? `数量 ${line.quantity} ${line.unit} · 计费面积 ${line.billableArea}㎡ · 单价 ￥${line.unitPrice}/${line.unit}`
      : `数量 ${line.quantity} ${line.unit} · 单价 ￥${line.unitPrice}/${line.unit}`;
    addText(detail, 25, '#65706e');
    if (line.description) addText(`说明：${line.description}`, 25, '#65706e');
    if (line.minimumApplied) {
      addText(`已应用最低收费 ￥${line.minimumCharge}`, 24, '#95621f');
    }
    line.addOns.forEach((item) => addPair(`＋ ${item.name}`, `￥${item.amount}`));
    addPair('项目合计', `￥${line.lineTotal}`, true);
    divider();
  });

  quote.calculation.orderAddOns.forEach((item) => addPair(item.name, `￥${item.amount}`));
  addPair('小计', `￥${quote.calculation.subtotal}`);
  if (quote.calculation.discountAmount !== '0.00') {
    addPair('优惠', `-￥${quote.calculation.discountAmount}`);
  }
  if (quote.calculation.manualAdjustment !== '0.00') {
    addPair('调整', `￥${quote.calculation.manualAdjustment}`);
  }
  if (quote.calculation.taxMode !== 'NONE') {
    const label = quote.calculation.taxMode === 'EXTRA' ? '另计税费' : '其中税额';
    addPair(`${label}（${quote.calculation.taxRate}%）`, `￥${quote.calculation.taxAmount}`);
  }
  if (quote.calculation.roundingAdjustment !== '0.00') {
    addPair('取整调整', `￥${quote.calculation.roundingAdjustment}`);
  }
  addPair('报价总额', `￥${quote.calculation.total}`, true);
  divider();
  if (quote.notes) {
    addText('备注', 30, '#1b2523', true);
    addText(quote.notes, 28, '#3f4b49');
  }
  if (quote.terms) {
    addText('报价条款', 30, '#1b2523', true);
    addText(quote.terms, 28, '#3f4b49');
  }
  divider();
  if (contact) addText(`联系商家：${contact}`, 25, '#3f4b49');
  addText('接受报价用于确认当前版本的价格与范围，不等同于付款或电子合同。', 25, '#66726f');
  return rows;
}

function renderPage(
  rows: ImageRow[],
  pageNumber: number,
  pageCount: number,
  pageTitle: string,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = PAGE_WIDTH;
  canvas.height = PAGE_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器不支持生成长图');
  context.fillStyle = '#f7f5ef';
  context.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
  context.fillStyle = '#ffffff';
  context.fillRect(36, 36, PAGE_WIDTH - 72, PAGE_HEIGHT - 72);
  context.font = '24px "Microsoft YaHei", sans-serif';
  context.fillStyle = '#75807d';
  context.textAlign = 'left';
  context.fillText(pageTitle, MARGIN, 76);
  context.textAlign = 'right';
  context.fillText(`第 ${pageNumber} / ${pageCount} 页`, PAGE_WIDTH - MARGIN, 76);
  context.textAlign = 'left';

  let y = CONTENT_TOP;
  for (const row of rows) {
    if (row.kind === 'text') {
      const size = row.size ?? 30;
      context.font = `${row.bold ? '600 ' : ''}${size}px "Microsoft YaHei", sans-serif`;
      context.fillStyle = row.color ?? '#1b2523';
      context.fillText(row.value ?? '', MARGIN + (row.indent ?? 0), y + size);
    } else if (row.kind === 'pair') {
      context.font = `${row.bold ? '600 ' : ''}30px "Microsoft YaHei", sans-serif`;
      context.fillStyle = '#33413e';
      context.fillText(row.label ?? '', MARGIN, y + 30);
      context.fillStyle = row.bold ? '#0b6b5f' : '#1b2523';
      context.textAlign = 'right';
      context.fillText(row.value ?? '', PAGE_WIDTH - MARGIN, y + 30);
      context.textAlign = 'left';
    } else {
      context.strokeStyle = '#dfe7e4';
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(MARGIN, y + 10);
      context.lineTo(PAGE_WIDTH - MARGIN, y + 10);
      context.stroke();
    }
    y += row.height;
  }
  return canvas;
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error('长图生成失败'))),
      'image/png',
    ),
  );
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export async function downloadQuoteImage(quote: PublicQuoteDocument): Promise<void> {
  const measureCanvas = document.createElement('canvas');
  const measure = measureCanvas.getContext('2d');
  if (!measure) throw new Error('当前浏览器不支持生成长图');
  const rows = buildRows(quote, measure);
  const pages = paginateRows(rows, PAGE_HEIGHT - CONTENT_TOP - CONTENT_BOTTOM);
  if (pages.length === 0) throw new Error('报价内容为空，无法生成长图');
  for (let index = 0; index < pages.length; index += 1) {
    const canvas = renderPage(
      pages[index]!,
      index + 1,
      pages.length,
      `${quote.merchant.name} · ${quote.quoteNumber} · V${quote.version}`,
    );
    const blob = await canvasBlob(canvas);
    const suffix =
      pages.length === 1
        ? ''
        : `-${String(index + 1).padStart(2, '0')}-of-${String(pages.length).padStart(2, '0')}`;
    downloadBlob(blob, `${quote.quoteNumber}-V${quote.version}${suffix}.png`);
  }
}
