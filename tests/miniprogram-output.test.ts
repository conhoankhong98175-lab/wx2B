import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(path), 'utf8');
}

describe('小程序客户输出回归约束', () => {
  it('分页长图按 backing canvas 实际比例导出，不裁掉右侧或下半部', () => {
    const javascript = source('miniprogram/pages/public-quote/index.js');
    const exportBlock = javascript.slice(javascript.indexOf('wx.canvasToTempFilePath'));
    expect(exportBlock).toContain('width: IMAGE_WIDTH * IMAGE_SCALE');
    expect(exportBlock).toContain('height: imageHeight * IMAGE_SCALE');
    expect(exportBlock).toContain('destWidth: IMAGE_WIDTH * IMAGE_SCALE');
    expect(exportBlock).toContain('destHeight: imageHeight * IMAGE_SCALE');
  });

  it('客户页和发布前预览均展示整单费用、税务与交付信息', () => {
    const publicTemplate = source('miniprogram/pages/public-quote/index.wxml');
    const previewTemplate = source('miniprogram/pages/editor/index.wxml');
    for (const label of ['整单附加费用', '手工调整', '税务模式', '税率', '取整调整', '交付周期']) {
      expect(publicTemplate).toContain(label);
      expect(previewTemplate).toContain(label);
    }
  });
});
