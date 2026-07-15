import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb } from 'pdf-lib';
import type { PDFPage, PDFFont } from 'pdf-lib';

import type { PublicQuoteDocument } from '../shared/contracts.ts';
import type { AppConfig } from './config.ts';
import { AppError } from './errors.ts';

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 44;
const FONT_SIZE = 10;
const LINE_HEIGHT = 17;

function findFont(config: AppConfig): string {
  const candidates = [
    config.pdfFontPath,
    resolve('assets/fonts/NotoSansCJKsc-Regular.otf'),
    'C:\\Windows\\Fonts\\simhei.ttf',
    'C:\\Windows\\Fonts\\msyh.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
    '/usr/share/fonts/truetype/arphic/ukai.ttc',
  ].filter(Boolean);
  const match = candidates.find((path) => existsSync(path));
  if (!match) {
    throw new AppError(
      503,
      'PDF_FONT_NOT_CONFIGURED',
      '服务器未找到中文字体，请配置 PDF_FONT_PATH',
    );
  }
  return match;
}

function stateLabel(state: PublicQuoteDocument['state']): string {
  const labels: Record<PublicQuoteDocument['state'], string> = {
    ACTIVE: '有效报价',
    CHANGE_REQUESTED: '客户申请修改',
    ACCEPTED: '客户已接受',
    EXPIRED: '报价已过期',
    WITHDRAWN: '报价已撤回',
    SUPERSEDED: '已被新版本替代',
  };
  return labels[state];
}

function addOnRule(addOn: PublicQuoteDocument['calculation']['orderAddOns'][number]): string {
  const labels = {
    FIXED: '固定金额',
    QUANTITY: '按数量',
    AREA: '按面积',
    PERCENT: '按比例',
  } as const;
  if (addOn.pricingType === 'FIXED') return `${labels.FIXED} ￥${addOn.price}`;
  if (addOn.pricingType === 'PERCENT') return `${labels.PERCENT} ${addOn.price}%`;
  return `${labels[addOn.pricingType]} ${addOn.parameter} × ￥${addOn.price}/${addOn.unit}`;
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const paragraphs = text.replaceAll('\r', '').split('\n');
  const output: string[] = [];
  for (const paragraph of paragraphs) {
    if (!paragraph) {
      output.push('');
      continue;
    }
    let line = '';
    for (const character of [...paragraph]) {
      const next = line + character;
      if (line && font.widthOfTextAtSize(next, size) > maxWidth) {
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

class PdfWriter {
  private page: PDFPage;
  private y = A4.height - MARGIN;

  constructor(
    private readonly document: PDFDocument,
    private readonly font: PDFFont,
  ) {
    this.page = document.addPage([A4.width, A4.height]);
  }

  private newPage(): void {
    this.page = this.document.addPage([A4.width, A4.height]);
    this.y = A4.height - MARGIN;
  }

  ensure(height: number): void {
    if (this.y - height < MARGIN + 20) this.newPage();
  }

  gap(height = 8): void {
    this.y -= height;
  }

  line(color = rgb(0.88, 0.89, 0.91)): void {
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: A4.width - MARGIN, y: this.y },
      thickness: 0.8,
      color,
    });
    this.y -= 8;
  }

  text(
    text: string,
    options: {
      size?: number;
      color?: ReturnType<typeof rgb>;
      indent?: number;
      maxWidth?: number;
      align?: 'left' | 'right';
    } = {},
  ): void {
    const size = options.size ?? FONT_SIZE;
    const indent = options.indent ?? 0;
    const maxWidth = options.maxWidth ?? A4.width - MARGIN * 2 - indent;
    const lines = wrapText(text, this.font, size, maxWidth);
    this.ensure(lines.length * LINE_HEIGHT + 4);
    for (const item of lines) {
      this.ensure(LINE_HEIGHT + 4);
      let x = MARGIN + indent;
      if (options.align === 'right') {
        x = A4.width - MARGIN - this.font.widthOfTextAtSize(item, size);
      }
      this.page.drawText(item, {
        x,
        y: this.y,
        size,
        font: this.font,
        color: options.color ?? rgb(0.12, 0.15, 0.19),
      });
      this.y -= LINE_HEIGHT;
    }
  }
}

function addPageNumbers(document: PDFDocument, font: PDFFont): void {
  const pages = document.getPages();
  pages.forEach((page, index) => {
    const text = `第 ${index + 1} / ${pages.length} 页`;
    page.drawText(text, {
      x: A4.width - MARGIN - font.widthOfTextAtSize(text, 8),
      y: 22,
      size: 8,
      font,
      color: rgb(0.45, 0.48, 0.53),
    });
  });
}

export async function createQuotePdf(
  quote: PublicQuoteDocument,
  config: AppConfig,
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const fontBytes = readFileSync(findFont(config));
  let font: PDFFont;
  try {
    font = await document.embedFont(fontBytes, { subset: true });
  } catch {
    throw new AppError(
      503,
      'PDF_FONT_UNSUPPORTED',
      '当前中文字体格式不受支持，请配置 TTF/OTF 字体文件',
    );
  }
  document.setTitle(`${quote.quoteNumber} V${quote.version} 报价单`);
  document.setAuthor(quote.merchant.name);
  document.setCreator(quote.merchant.name);
  document.setProducer('');
  document.setCreationDate(new Date(quote.publishedAt));

  const writer = new PdfWriter(document, font);
  writer.text('报价单', { size: 22, color: rgb(0.05, 0.36, 0.32) });
  writer.text(quote.merchant.name, { size: 14 });
  const contacts = [
    quote.merchant.contactName,
    quote.merchant.contactPhone,
    quote.merchant.contactWechat ? `微信：${quote.merchant.contactWechat}` : '',
  ].filter(Boolean);
  if (contacts.length) writer.text(contacts.join(' · '), { color: rgb(0.38, 0.42, 0.48) });
  writer.gap(4);
  writer.line();

  writer.text(`报价编号：${quote.quoteNumber}`);
  writer.text(`版本：V${quote.version} 状态：${stateLabel(quote.state)}`);
  writer.text(`客户：${quote.customerName}`);
  if (quote.projectName) writer.text(`项目：${quote.projectName}`);
  writer.text(`报价日期：${quote.publishedDate} 有效至：${quote.validUntil} 23:59`);
  if (quote.deliveryPeriod) writer.text(`交付周期：${quote.deliveryPeriod}`);
  writer.gap(4);
  writer.line(rgb(0.05, 0.36, 0.32));

  quote.calculation.lines.forEach((line, index) => {
    writer.ensure(80);
    writer.text(`${index + 1}. ${line.name}`, { size: 12 });
    const parameters = [`数量 ${line.quantity} ${line.unit}`];
    if (line.lengthMeters && line.widthMeters) {
      parameters.push(`尺寸 ${line.lengthMeters}m × ${line.widthMeters}m`);
    }
    if (line.billableArea) parameters.push(`计费面积 ${line.billableArea}㎡`);
    if (line.lossRate !== '0.0000') parameters.push(`损耗 ${line.lossRate}%`);
    writer.text(parameters.join(' '), { indent: 12, color: rgb(0.34, 0.38, 0.43) });
    if (line.description) writer.text(`说明：${line.description}`, { indent: 12 });
    writer.text(`基础金额 ￥${line.baseAmount}${line.minimumApplied ? '（已应用最低收费）' : ''}`, {
      indent: 12,
    });
    line.addOns.forEach((addOn) => {
      writer.text(`＋ ${addOn.name}（${addOnRule(addOn)}） ￥${addOn.amount}`, { indent: 24 });
    });
    writer.text(`项目合计 ￥${line.lineTotal}`, { align: 'right', size: 11 });
    writer.line();
  });

  if (quote.calculation.orderAddOns.length) {
    writer.text('整单附加费用', { size: 11 });
    quote.calculation.orderAddOns.forEach((addOn) => {
      writer.text(`${addOn.name}（${addOnRule(addOn)}） ￥${addOn.amount}`, { indent: 12 });
    });
  }
  writer.text(`小计 ￥${quote.calculation.subtotal}`, { align: 'right' });
  if (quote.calculation.discountAmount !== '0.00') {
    writer.text(`优惠 -￥${quote.calculation.discountAmount}`, { align: 'right' });
  }
  if (quote.calculation.manualAdjustment !== '0.00') {
    writer.text(`调整 ￥${quote.calculation.manualAdjustment}`, { align: 'right' });
  }
  if (quote.calculation.taxMode !== 'NONE') {
    const label = quote.calculation.taxMode === 'INCLUDED' ? '其中税额' : '另计税费';
    writer.text(`${label}（${quote.calculation.taxRate}%） ￥${quote.calculation.taxAmount}`, {
      align: 'right',
    });
  }
  if (quote.calculation.roundingAdjustment !== '0.00') {
    writer.text(`取整调整 ￥${quote.calculation.roundingAdjustment}`, { align: 'right' });
  }
  writer.text(`报价总额 ￥${quote.calculation.total}`, {
    align: 'right',
    size: 17,
    color: rgb(0.05, 0.36, 0.32),
  });
  writer.gap(8);

  if (quote.notes) {
    writer.text('备注', { size: 12 });
    writer.text(quote.notes);
    writer.gap(4);
  }
  if (quote.terms) {
    writer.text('报价条款', { size: 12 });
    writer.text(quote.terms);
    writer.gap(4);
  }
  writer.line();
  writer.text('本报价用于说明当前版本的价格与服务范围，不等同于付款或电子合同。', {
    size: 8,
    color: rgb(0.42, 0.45, 0.5),
  });
  addPageNumbers(document, font);
  return document.save();
}
