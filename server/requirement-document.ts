// A reading view only: never rewrite stored source lines or their evidence positions.
export function requirementDocumentView(
  lines: string[],
  start = 1,
  count = lines.length,
) {
  const clean = (line: string) => line.replace(/^\[第\d+页\]\s*/, "").trim();
  const capability =
    /支持|不支持|不低于|不少于|不超过|不得|至少|至多|应能|须能|需能|功能|性能|接口|协议|并发|响应时间|保存.*天|准确率|反潜回|\b(?:GB\/T|HTTPS?|TCP|MQTT)\b|[≥≤]/i;
  const counts = new Map<string, number>();
  for (const line of lines.filter((l) => /^\[第\d+页\]/.test(l))) {
    const text = clean(line);
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  const excluded: { line: number; reason: string }[] = [];
  const kept: string[] = [];
  let outside = false;
  for (let i = 0; i < Math.min(lines.length, start - 1 + count); i++) {
    const text = clean(lines[i]);
    const heading = text
      .replace(/^#{1,6}\s*/, "")
      .replace(/^[一二三四五六七八九十\d]+[、.．)）]\s*/, "")
      .trim();
    let reason = "";
    if (
      /^(?:评分办法|评标办法|评分标准|资格要求|资质要求|投标人资格要求|供应商资格要求)[：:\s]*$/.test(
        heading,
      )
    ) {
      outside = true;
      reason = "评分与供应商资质不属于本阶段需求分析";
    } else if (
      /^(?:技术要求|技术需求|功能要求|功能需求|性能要求|接口要求|部署要求|需求清单|采购需求|建设内容|项目需求)[：:\s]*$/.test(
        heading,
      ) ||
      /^\[工作表：/.test(text)
    )
      outside = false;
    if (!reason) {
      if (
        /^(?:目\s*录|第\s*\d+\s*页(?:\s*[\/／]?\s*共\s*\d+\s*页)?|Page\s+\d+(?:\s+of\s+\d+)?)$/i.test(
          text,
        ) ||
        (!capability.test(text) &&
          /(?:\.{3,}|…{2,}|·{4,})\s*\d+\s*$/.test(text)) ||
        /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?$/.test(text)
      )
        reason = "目录、页码或排版分隔线";
      else if (
        /^\[第\d+页\]/.test(lines[i]) &&
        (counts.get(text) ?? 0) >= 3 &&
        text.length < 70 &&
        /项目.*(?:文件|招标|清单)|招标文件|技术规范书|投标文件|有限公司|保密|编制单位/.test(
          text,
        ) &&
        !/\d/.test(text) &&
        !capability.test(text)
      )
        reason = "重复页眉页脚";
      else if (
        !capability.test(text) &&
        ((outside &&
          /评分|得分|计分|分值|报价|营业执照|注册资本|财务报表|信用记录|供应商资格/.test(
            text,
          )) ||
          /^(?:投标人|供应商|投标单位|供应单位).*(?:营业执照|资质证书|经营许可|注册资本|财务|信用记录)|^(?:价格分|商务分|投标报价).*(?:计分|得分|计算|评分)/.test(
            text,
          ))
      )
        reason = "评分与供应商资质不属于本阶段需求分析";
    }
    if (i < start - 1) continue;
    if (reason) excluded.push({ line: i + 1, reason });
    else kept.push(`L${i + 1}: ${lines[i]}`);
  }
  return {
    text: kept.join("\n"),
    excluded,
    note: "仅为需求阅读视图，行号对应未修改的完整原文；排除项可回查。目录标题保留作上下文，不应单独抽取为需求；不能跨噪声行拼接原文。",
  };
}
