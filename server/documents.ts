import mammoth from "mammoth";
import ExcelJS from "exceljs";
import { extname } from "node:path";
import { AppError } from "./errors.js";
export const supportedExtensions = new Set([
  ".docx",
  ".xlsx",
  ".pdf",
  ".md",
  ".txt",
]);
export async function parseDocument(
  name: string,
  buffer: Buffer,
): Promise<string[]> {
  const extension = extname(name).toLowerCase();
  if (!supportedExtensions.has(extension))
    throw new AppError(
      400,
      "支持 DOCX、XLSX、PDF、Markdown、TXT；旧版 DOC / XLS 请先转换",
    );
  let lines: string[] = [];
  if (extension === ".docx") {
    const result = await mammoth.extractRawText({ buffer });
    lines = result.value.split(/\r?\n/).filter((line) => line.trim());
  } else if (extension === ".xlsx") {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
    for (const sheet of workbook.worksheets) {
      if (sheet.state !== "visible" || /Wps|Reserved/i.test(sheet.name))
        continue;
      lines.push(`[工作表：${sheet.name}]`);
      sheet.eachRow((row) => {
        const cells: string[] = [];
        row.eachCell({ includeEmpty: true }, (cell) => cells.push(cell.text));
        const text = cells.join(" | ");
        if (text.replace(/[|\s]/g, "")) lines.push(text);
      });
    }
  } else if (extension === ".pdf") {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const document = await getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
    }).promise;
    try {
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        let line = "";
        let previousY: number | null = null;
        for (const item of content.items) {
          if (!("str" in item)) continue;
          const y = item.transform[5];
          if (
            previousY !== null &&
            Math.abs(y - previousY) > 2 &&
            line.trim()
          ) {
            lines.push(`[第${pageNumber}页] ${line}`);
            line = "";
          }
          line += item.str;
          previousY = y;
          if (item.hasEOL && line.trim()) {
            lines.push(`[第${pageNumber}页] ${line}`);
            line = "";
            previousY = null;
          }
        }
        if (line.trim()) lines.push(`[第${pageNumber}页] ${line}`);
        page.cleanup();
      }
    } finally {
      await document.destroy();
    }
  } else {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    if (text.includes("\0"))
      throw new AppError(400, "文件包含二进制内容，请上传 UTF-8 文本");
    lines = text.split(/\r?\n/).filter((line) => line.trim());
  }
  if (!lines.length)
    throw new AppError(422, "未提取到有效文本；扫描 PDF 请先完成 OCR 后上传");
  if (lines.length > 50000 || lines.join("\n").length > 4_000_000)
    throw new AppError(422, "文档超过处理上限，请按标段拆分后上传");
  return lines;
}
export function numberedLines(lines: string[], start = 1, count = 150) {
  return lines
    .slice(start - 1, start - 1 + count)
    .map((line, index) => `L${start + index}: ${line}`)
    .join("\n");
}
